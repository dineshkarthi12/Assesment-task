import { Icon } from '@/components/Icon';
import { StatusGlyph } from '@/components/StatusBadge';
import { statusLabel } from '@/lib/format';
import type { AssetStatus } from '@/lib/types';
import { STATUSES } from '@/lib/viewQuery';
import { type BulkOutcome, groupFailures } from './bulkStatus';

export type BulkState =
  | { phase: 'running'; status: AssetStatus; count: number; batchesDone: number; batchesTotal: number }
  | { phase: 'done'; outcome: BulkOutcome; names: ReadonlyMap<string, string> };

interface BarProps {
  count: number;
  loadedCount: number;
  busy: boolean;
  onApply: (status: AssetStatus) => void;
  onSelectAll: () => void;
  onClear: () => void;
}

/** Appears only with a selection, in the accent colour: the one place the page says "you are acting on these". */
export function BulkBar({ count, loadedCount, busy, onApply, onSelectAll, onClear }: BarProps) {
  return (
    <div className="bulkbar" role="group" aria-label="Bulk actions">
      <span className="bulkbar__count">{count.toLocaleString()} selected</span>
      <span className="bulkbar__label" aria-hidden="true">
        Move to
      </span>
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          className="button"
          aria-label={`Move to ${statusLabel(s)}`}
          disabled={busy}
          onClick={() => onApply(s)}
        >
          <StatusGlyph status={s} colored />
          {statusLabel(s)}
        </button>
      ))}
      <span className="bulkbar__end">
        {count < loadedCount && (
          <button type="button" className="button button--quiet" disabled={busy} onClick={onSelectAll}>
            Select all {loadedCount.toLocaleString()} loaded
          </button>
        )}
        <button type="button" className="button button--quiet" disabled={busy} onClick={onClear}>
          Clear selection
        </button>
      </span>
    </div>
  );
}

/** One sentence for the live region and the report heading, so they never disagree. */
export function summarizeOutcome(outcome: BulkOutcome): string {
  const target = statusLabel(outcome.status);
  const total = outcome.succeeded.length + outcome.failed.length;
  if (outcome.failed.length === 0) {
    return `Moved ${total.toLocaleString()} ${total === 1 ? 'asset' : 'assets'} to ${target}.`;
  }
  return `Moved ${outcome.succeeded.length.toLocaleString()} of ${total.toLocaleString()} to ${target}. ${outcome.failed.length.toLocaleString()} didn’t change.`;
}

/** How many names to list before folding the rest behind "Show all". */
const NAMES_SHOWN = 3;

interface ReportProps {
  state: BulkState;
  onRetry: (ids: string[], status: AssetStatus) => void;
  onDismiss: () => void;
}

export function BulkReport({ state, onRetry, onDismiss }: ReportProps) {
  if (state.phase === 'running') {
    return (
      <div className="bulk-report bulk-report--running" role="region" aria-label="Bulk change">
        <div className="bulk-report__content">
          <p className="bulk-report__summary">
            Moving {state.count.toLocaleString()} {state.count === 1 ? 'asset' : 'assets'} to{' '}
            {statusLabel(state.status)}…
          </p>
          <p>
            {state.batchesDone} of {state.batchesTotal} {state.batchesTotal === 1 ? 'batch' : 'batches'} done.
            Cards already show the new status.
          </p>
        </div>
      </div>
    );
  }

  const { outcome, names } = state;
  const partial = outcome.failed.length > 0;
  const groups = groupFailures(outcome.failed);
  const retryIds = outcome.failed.filter((f) => f.retryable).map((f) => f.id);
  const nameOf = (id: string) => names.get(id) ?? id;

  return (
    <div
      className={`bulk-report ${partial ? 'bulk-report--partial' : 'bulk-report--success'}`}
      role="region"
      aria-label="Bulk change result"
    >
      <Icon name={partial ? 'alert' : 'check'} />
      <div className="bulk-report__content">
        <p className="bulk-report__summary">{summarizeOutcome(outcome)}</p>
        {partial && <p>They’re back to their previous status. Here’s why:</p>}

        {groups.map((group) => (
          <div key={group.key} className="bulk-report__group">
            <p>
              <strong>
                {group.title} ({group.ids.length})
              </strong>{' '}
              — {group.detail}
            </p>
            <ul className="bulk-report__names">
              {group.ids.slice(0, NAMES_SHOWN).map((id) => (
                <li key={id}>{nameOf(id)}</li>
              ))}
            </ul>
            {group.ids.length > NAMES_SHOWN && (
              <details>
                <summary>Show all {group.ids.length}</summary>
                <ul className="bulk-report__names">
                  {group.ids.slice(NAMES_SHOWN).map((id) => (
                    <li key={id}>{nameOf(id)}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}

        <div className="bulk-report__actions">
          {retryIds.length > 0 && (
            <button
              type="button"
              className="button button--primary"
              onClick={() => onRetry(retryIds, outcome.status)}
            >
              Retry {retryIds.length.toLocaleString()}
            </button>
          )}
          <button type="button" className="button button--quiet" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
