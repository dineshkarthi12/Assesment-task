import { memo } from 'react';
import { formatBytes, formatDate, statusLabel } from '@/lib/format';
import type { Asset } from '@/lib/types';
import { useRenderCount } from '@/lib/useRenderCount';
import { Icon } from '@/components/Icon';
import { StatusBadge } from '@/components/StatusBadge';
import { type SelectionStore, useIsSelected } from '@/features/selection/selectionStore';
import { type AssetStore, type WriteFailure, useAssetView, useWriteState } from './assetStore';
import { Thumbnail } from './Thumbnail';

interface Props {
  asset: Asset;
  /** Position in the loaded list; the grid's keyboard handling reads it from data-index. */
  index: number;
  column: number;
  /** The grid's single tab stop. */
  tabbable: boolean;
  active: boolean;
  selection: SelectionStore;
  assets: AssetStore;
  onOpen: (id: string) => void;
  /** Checkbox changed; `extend` is true for Shift-click. */
  onCheck: (id: string, extend: boolean) => void;
}

const FAILURE_LABELS: Record<string, string> = {
  legal_hold: 'Not changed: legal hold',
  not_found: 'Not changed: missing',
  conflict: 'Not changed: retry',
};

function failureLabel(failure: WriteFailure): string {
  return FAILURE_LABELS[failure.code] ?? (failure.retryable ? 'Not changed: retry' : 'Not changed');
}

/**
 * One grid cell. Memoised on stable props; selection, optimistic status and
 * write failures are each read from a store for this id only, so a change to
 * another asset never renders this card.
 *
 * For assistive tech the cell carries one concise label (name, status, kind,
 * size, date) and `aria-selected`; the thumbnail is decorative.
 */
export const AssetCard = memo(function AssetCard({
  asset: source,
  index,
  column,
  tabbable,
  active,
  selection,
  assets,
  onOpen,
  onCheck,
}: Props) {
  useRenderCount('AssetCard');
  const asset = useAssetView(assets, source);
  const { pending, failure } = useWriteState(assets, asset.id);
  const selected = useIsSelected(selection, asset.id);

  const label = [
    asset.name,
    statusLabel(asset.status) + (pending ? ', saving' : ''),
    failure ? failureLabel(failure) : null,
    asset.kind,
    formatBytes(asset.sizeBytes),
    `updated ${formatDate(asset.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <div
      role="gridcell"
      aria-colindex={column}
      aria-selected={selected}
      aria-current={active || undefined}
      aria-label={label}
      tabIndex={tabbable ? 0 : -1}
      data-index={index}
      className={
        'card' +
        (selected ? ' card--selected' : '') +
        (active ? ' card--active' : '') +
        (failure ? ' card--failed' : '')
      }
      onClick={() => onOpen(asset.id)}
    >
      <Thumbnail asset={asset} className="card__thumb" />
      {active && (
        <span className="card__open-tag" aria-hidden="true">
          Open
        </span>
      )}
      <div className="card__body">
        <p className="card__name" title={asset.name}>
          {asset.name}
        </p>
        <p className="card__meta">
          {asset.kind} · {formatBytes(asset.sizeBytes)} · {formatDate(asset.updatedAt)}
        </p>
        <div className="card__status">
          <StatusBadge status={asset.status} pending={pending} />
          {pending && <span className="card__note">Saving…</span>}
          {failure && (
            <span className="card__note card__note--failed">
              <Icon name="alert" />
              {failureLabel(failure)}
            </span>
          )}
        </div>
      </div>
      {/* Mouse affordance. Keyboard users select with Space on the cell, so the
          checkbox is not a second tab stop; it keeps its name for anyone who
          reaches it by pointer or by browsing. */}
      <input
        type="checkbox"
        className="card__check"
        tabIndex={-1}
        checked={selected}
        aria-label={`Select ${asset.name}`}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onCheck(asset.id, (e.nativeEvent as MouseEvent).shiftKey === true)}
      />
    </div>
  );
});

export function SkeletonCard() {
  return (
    <div className="card card--skeleton" aria-hidden="true">
      <div className="card__thumb thumb" />
      <div className="card__body">
        <span className="skeleton-line" />
        <span className="skeleton-line skeleton-line--short" />
      </div>
    </div>
  );
}
