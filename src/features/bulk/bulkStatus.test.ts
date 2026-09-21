import { describe, expect, it } from 'vitest';
import { ApiError } from '@/api/errors';
import { createAssetStore } from '@/features/assets/assetStore';
import type { Asset, AssetStatus, BulkResult } from '@/lib/types';
import { BULK_BATCH_SIZE, BULK_CONCURRENCY, groupFailures, runBulkStatus } from './bulkStatus';

function asset(id: string, status: AssetStatus = 'draft', version = 1): Asset {
  return {
    id,
    name: `Asset ${id}`,
    kind: 'image',
    status,
    tags: [],
    collectionId: 'c_brand',
    owner: { id: 'u_01', name: 'Owner' },
    sizeBytes: 1,
    width: 1,
    height: 1,
    durationSec: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version,
    hasThumbnail: true,
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `a_${String(i).padStart(5, '0')}`);

function allOk(batch: string[], status: AssetStatus): BulkResult {
  return {
    applied: batch.length,
    failed: 0,
    results: batch.map((id) => ({ id, ok: true as const, asset: asset(id, status, 2) })),
  };
}

describe('runBulkStatus', () => {
  it('never sends more than 50 ids per call, nor more than 3 calls at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sizes: number[] = [];
    const send = async (batch: string[], status: AssetStatus) => {
      sizes.push(batch.length);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return allOk(batch, status);
    };

    const outcome = await runBulkStatus(ids(501), 'approved', { store: createAssetStore(), send });

    expect(Math.max(...sizes)).toBe(BULK_BATCH_SIZE);
    expect(sizes).toHaveLength(11);
    expect(maxInFlight).toBe(BULK_CONCURRENCY);
    expect(outcome.succeeded).toHaveLength(501);
    expect(outcome.failed).toHaveLength(0);
  });

  it('shows the new status before the server answers, then rolls back only the failures', async () => {
    const store = createAssetStore();
    const listed = ['a', 'b', 'c'].map((id) => asset(id));
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const send = async (): Promise<BulkResult> => {
      await answered;
      return {
        applied: 1,
        failed: 2,
        results: [
          { id: 'a', ok: true, asset: asset('a', 'approved', 2) },
          { id: 'b', ok: false, code: 'legal_hold' },
          { id: 'c', ok: false, code: 'conflict' },
        ],
      };
    };

    const running = runBulkStatus(['a', 'b', 'c'], 'approved', { store, send });
    expect(listed.map((a) => store.view(a).status)).toEqual(['approved', 'approved', 'approved']);
    expect(store.isPending('b')).toBe(true);

    release();
    const outcome = await running;

    expect(listed.map((a) => store.view(a).status)).toEqual(['approved', 'draft', 'draft']);
    expect(store.view(listed[0]!).version).toBe(2); // the server's copy replaced the list's
    expect(outcome.succeeded).toEqual(['a']);
    expect(outcome.failed).toEqual([
      { id: 'b', code: 'legal_hold', retryable: false },
      { id: 'c', code: 'conflict', retryable: true },
    ]);
    expect(store.failure('b')?.code).toBe('legal_hold');
    expect(store.isPending('b')).toBe(false);
  });

  it('rolls back a whole batch whose request failed, and only that batch', async () => {
    const store = createAssetStore();
    const all = ids(120); // batches of 50, 50, 20
    const send = async (batch: string[], status: AssetStatus) => {
      if (batch[0] === all[50]) {
        throw new ApiError({ status: 503, code: 'upstream_unavailable', message: 'x' });
      }
      return allOk(batch, status);
    };

    const outcome = await runBulkStatus(all, 'in_review', { store, send });

    expect(outcome.succeeded).toHaveLength(70);
    expect(outcome.failed).toHaveLength(50);
    expect(outcome.failed.every((f) => f.retryable && f.code === 'upstream_unavailable')).toBe(true);
    expect(store.view(asset(all[60]!)).status).toBe('draft');
    expect(store.view(asset(all[10]!)).status).toBe('in_review');
  });

  it('does not offer a rejected (4xx) batch for retry', async () => {
    const send = async (): Promise<BulkResult> => {
      throw new ApiError({ status: 400, code: 'bad_request', message: 'x' });
    };
    const outcome = await runBulkStatus(['a'], 'approved', { store: createAssetStore(), send });
    expect(outcome.failed).toEqual([{ id: 'a', code: 'bad_request', retryable: false }]);
  });

  it("does not let an earlier operation's failure undo a later change to the same asset", async () => {
    const store = createAssetStore();
    const listed = asset('a');
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const send = async (): Promise<BulkResult> => {
      await answered;
      return { applied: 0, failed: 1, results: [{ id: 'a', ok: false, code: 'conflict' }] };
    };

    const first = runBulkStatus(['a'], 'approved', { store, send });
    store.beginWrite(['a'], 'archived'); // a second change starts while the first is in flight
    release();
    await first;

    expect(store.view(listed).status).toBe('archived');
    expect(store.isPending('a')).toBe(true);
  });
});

describe('groupFailures', () => {
  it('separates what retry can fix from what it cannot, retryable first', () => {
    const groups = groupFailures([
      { id: 'a', code: 'legal_hold', retryable: false },
      { id: 'b', code: 'conflict', retryable: true },
      { id: 'c', code: 'legal_hold', retryable: false },
    ]);
    expect(groups.map((g) => [g.key, g.retryable, g.ids])).toEqual([
      ['conflict', true, ['b']],
      ['legal_hold', false, ['a', 'c']],
    ]);
  });
});
