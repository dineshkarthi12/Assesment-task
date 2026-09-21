import type { AssetKind, AssetQuery, AssetStatus } from './types';

export type SortValue = NonNullable<AssetQuery['sort']>;

/** Everything about the current view that belongs in a shareable URL. */
export interface ViewQuery {
  q: string;
  status: AssetStatus[];
  kind: AssetKind[];
  tag: string[];
  sort: SortValue;
}

export const STATUSES: readonly AssetStatus[] = ['draft', 'in_review', 'approved', 'archived'];
export const KINDS: readonly AssetKind[] = ['image', 'video', 'document'];
export const SORTS: ReadonlyArray<{ value: SortValue; label: string }> = [
  { value: 'updatedAt:desc', label: 'Recently updated' },
  { value: 'name:asc', label: 'Name A–Z' },
  { value: 'sizeBytes:desc', label: 'Largest first' },
  { value: 'createdAt:desc', label: 'Newest' },
];
export const DEFAULT_SORT: SortValue = 'updatedAt:desc';
export const PAGE_SIZE = 50; // the API's cap: fewest round trips against the rate limit

export const EMPTY_VIEW: ViewQuery = { q: '', status: [], kind: [], tag: [], sort: DEFAULT_SORT };

/** Keeps only allowed values, deduped, in the allowed list's canonical order. */
function pickAllowed<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  const wanted = new Set((raw ?? '').split(',').map((s) => s.trim()));
  return allowed.filter((value) => wanted.has(value));
}

function parseTags(raw: string | null): string[] {
  const tags = (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [...new Set(tags)].sort();
}

/**
 * The URL is untrusted input — it may be hand-edited or come from an old link.
 * Unknown statuses, kinds and sorts are dropped rather than sent: an unknown
 * sort is a hard `400` from the API, and a user should never see that for
 * having followed a link.
 */
export function parseViewQuery(search: string): ViewQuery {
  const params = new URLSearchParams(search);
  const sort = params.get('sort');
  return {
    q: params.get('q') ?? '',
    status: pickAllowed(params.get('status'), STATUSES),
    kind: pickAllowed(params.get('kind'), KINDS),
    tag: parseTags(params.get('tag')),
    sort: SORTS.some((s) => s.value === sort) ? (sort as SortValue) : DEFAULT_SORT,
  };
}

/** Defaults are omitted, so an unfiltered view is a clean URL. */
export function serializeViewQuery(view: ViewQuery): string {
  const params = new URLSearchParams();
  if (view.q) params.set('q', view.q);
  if (view.status.length) params.set('status', view.status.join(','));
  if (view.kind.length) params.set('kind', view.kind.join(','));
  if (view.tag.length) params.set('tag', view.tag.join(','));
  if (view.sort !== DEFAULT_SORT) params.set('sort', view.sort);
  return params.toString();
}

export function toAssetQuery(view: ViewQuery): AssetQuery {
  return {
    q: view.q,
    status: view.status,
    kind: view.kind,
    tag: view.tag,
    sort: view.sort,
    limit: PAGE_SIZE,
  };
}

export function hasFilters(view: ViewQuery): boolean {
  return (
    view.q.trim() !== '' || view.status.length > 0 || view.kind.length > 0 || view.tag.length > 0
  );
}
