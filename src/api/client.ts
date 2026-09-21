import type { Asset, AssetPage, AssetQuery, BulkResult, Facets } from '@/lib/types';
import { get, write } from './http';

/**
 * Canonical search params. Array filters are sorted so that the same filter set
 * always produces the same string, which matters twice over: it is the
 * de-duplication key, and the server binds cursors to the exact query string it
 * saw — `status=draft,approved` then `status=approved,draft` would be a
 * `stale_cursor`. `q` is trimmed and lowercased here because the server does the
 * same, so `Tra`, `tra` and `tra ` are one query rather than three requests.
 */
function toSearchParams(query: AssetQuery): URLSearchParams {
  const params = new URLSearchParams();
  const q = query.q?.trim().toLowerCase();
  if (q) params.set('q', q);
  if (query.status?.length) params.set('status', [...query.status].sort().join(','));
  if (query.kind?.length) params.set('kind', [...query.kind].sort().join(','));
  if (query.tag?.length) params.set('tag', [...query.tag].sort().join(','));
  if (query.collectionId) params.set('collectionId', query.collectionId);
  if (query.owner) params.set('owner', query.owner);
  if (query.sort) params.set('sort', query.sort);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  return params;
}

/** Identity of a result set: everything that shapes it, excluding the page cursor. */
export function assetQueryKey(query: AssetQuery): string {
  const params = toSearchParams({ ...query, cursor: undefined });
  return params.toString();
}

export function listAssets(query: AssetQuery, signal?: AbortSignal): Promise<AssetPage> {
  return get<AssetPage>(`/api/assets?${toSearchParams(query).toString()}`, signal);
}

export function getAsset(id: string, signal?: AbortSignal): Promise<Asset> {
  return get<Asset>(`/api/assets/${encodeURIComponent(id)}`, signal);
}

export function getAssetsByIds(
  ids: string[],
  signal?: AbortSignal,
): Promise<{ items: Asset[]; missing: string[] }> {
  // Note: the endpoint rejects more than 25 ids per call.
  return get(`/api/assets/batch?ids=${ids.map(encodeURIComponent).join(',')}`, signal);
}

export function getFacets(signal?: AbortSignal): Promise<Facets> {
  return get<Facets>('/api/facets', signal);
}

export function updateAsset(
  id: string,
  version: number,
  patch: Partial<Pick<Asset, 'name' | 'status' | 'tags'>>,
): Promise<Asset> {
  return write<Asset>(`/api/assets/${encodeURIComponent(id)}`, 'PATCH', { version, patch });
}

export function bulkSetStatus(ids: string[], status: Asset['status']): Promise<BulkResult> {
  // Note: the endpoint rejects more than 50 ids per call.
  return write<BulkResult>('/api/assets/bulk-status', 'POST', { ids, status });
}

export const thumbnailUrl = (id: string) => `/api/thumb/${encodeURIComponent(id)}.svg`;
