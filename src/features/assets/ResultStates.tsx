import type { ApiError } from '@/api/errors';
import { useNetworkState } from '@/api/network';
import { Icon } from '@/components/Icon';
import { describeError } from '@/lib/errorCopy';
import { SkeletonCard } from './AssetCard';

/**
 * Loading, empty and failed are three different answers and must never share a
 * screen. The baseline showed "Nothing matches" for all three, because it
 * rendered the empty state whenever `items` was empty — including before the
 * first response and after a failed one.
 *
 * Each is recognisable before it is read: loading keeps the grid's shape,
 * empty and error each have their own icon, and each says what to do next.
 */

export function LoadingState() {
  const { reachable } = useNetworkState();
  return (
    <div className="state state--loading" aria-busy="true">
      <p className="state__detail">
        {reachable ? 'Loading assets…' : 'Waiting for the connection to load these results…'}
      </p>
      <div className="skeleton-grid" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ filtered, onClear }: { filtered: boolean; onClear: () => void }) {
  return (
    <div className="state">
      <Icon name="search" />
      <p className="state__title">
        {filtered ? 'No assets match these filters' : 'The library is empty'}
      </p>
      {filtered && (
        <>
          <p className="state__detail">Try a shorter search, or remove a filter.</p>
          <button type="button" className="button button--primary" onClick={onClear}>
            Clear filters
          </button>
        </>
      )}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const copy = describeError(error);
  return (
    <div className="state state--error">
      <Icon name="alert" />
      <p className="state__title">{copy.title}</p>
      <p className="state__detail">{copy.detail}</p>
      <button type="button" className="button button--primary" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
