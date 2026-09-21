import { bulkSetStatus } from '@/api/client';
import { isRetryable, toApiError } from '@/api/errors';
import { chunk, mapWithConcurrency } from '@/lib/concurrency';
import type { AssetStatus, BulkResult } from '@/lib/types';
import type { AssetStore, WriteFailure } from '@/features/assets/assetStore';

/** The API refuses more than 50 ids per call. */
export const BULK_BATCH_SIZE = 50;
/**
 * Batches in flight at once. 500 selected assets is 10 batches; three at a
 * time finishes in about four round trips while spending at most three of the
 * 80-per-10s requests at any moment, leaving room for reads and retries.
 */
export const BULK_CONCURRENCY = 3;

export interface BulkFailure extends WriteFailure {
  id: string;
}

export interface BulkOutcome {
  status: AssetStatus;
  succeeded: string[];
  failed: BulkFailure[];
}

interface Options {
  store: AssetStore;
  send?: (ids: string[], status: AssetStatus) => Promise<BulkResult>;
  onProgress?: (batchesDone: number, batchesTotal: number) => void;
}

/**
 * Per-item codes from a 207. `conflict` is a transient write race on the
 * server and succeeds on retry; `legal_hold` and `not_found` are properties of
 * the asset and will fail identically every time, so they are never offered
 * for retry.
 */
function itemFailure(id: string, code: string): BulkFailure {
  return { id, code, retryable: code === 'conflict' };
}

/**
 * Applies `status` to `ids` optimistically, then confirms or rolls back each
 * asset individually as batch results arrive. Never throws: every id ends up
 * in exactly one of `succeeded` or `failed`.
 */
export async function runBulkStatus(
  ids: readonly string[],
  status: AssetStatus,
  { store, send = bulkSetStatus, onProgress }: Options,
): Promise<BulkOutcome> {
  const opId = store.beginWrite(ids, status);
  const batches = chunk(ids, BULK_BATCH_SIZE);
  const succeeded: string[] = [];
  const failed: BulkFailure[] = [];
  let done = 0;

  const fail = (failure: BulkFailure) => {
    store.rollback(failure.id, opId, failure);
    failed.push(failure);
  };

  await mapWithConcurrency(batches, BULK_CONCURRENCY, async (batch) => {
    try {
      const response = await send(batch, status);
      const reported = new Set<string>();
      for (const item of response.results) {
        reported.add(item.id);
        if (item.ok) {
          store.confirm(item.asset, opId);
          succeeded.push(item.id);
        } else {
          fail(itemFailure(item.id, item.code));
        }
      }
      // Anything the server did not report on is treated as not applied.
      for (const id of batch) {
        if (!reported.has(id)) fail({ id, code: 'no_result', retryable: true });
      }
    } catch (err) {
      // The whole batch failed before any per-item result: none of it applied.
      const error = toApiError(err);
      const retryable = isRetryable(error);
      for (const id of batch) fail({ id, code: error.code, retryable });
    } finally {
      done += 1;
      onProgress?.(done, batches.length);
    }
  });

  return { status, succeeded, failed };
}

export interface FailureGroup {
  key: string;
  title: string;
  detail: string;
  retryable: boolean;
  ids: string[];
}

const ITEM_COPY: Record<string, { title: string; detail: string }> = {
  legal_hold: {
    title: 'On legal hold',
    detail:
      'Bulk changes are refused for assets on legal hold. Open one to change it on its own — it can never be archived.',
  },
  not_found: {
    title: 'No longer in the library',
    detail: 'These may have been deleted since the list loaded.',
  },
  conflict: {
    title: 'Changed by someone else at the same moment',
    detail: 'Nothing was overwritten. Retrying is safe.',
  },
};

/** Groups failures by what the user should do about them, retryable groups first. */
export function groupFailures(failures: readonly BulkFailure[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const f of failures) {
    const copy =
      ITEM_COPY[f.code] ??
      (f.retryable
        ? { title: 'Couldn’t reach the server', detail: 'Nothing was changed. Retrying is safe.' }
        : { title: 'Rejected by the server', detail: 'Retrying will not help.' });
    const key = ITEM_COPY[f.code] ? f.code : f.retryable ? 'transient' : 'rejected';
    const group = groups.get(key) ?? { key, ...copy, retryable: f.retryable, ids: [] };
    group.ids.push(f.id);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => Number(b.retryable) - Number(a.retryable));
}
