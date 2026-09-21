import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { assetQueryKey, listAssets } from '@/api/client';
import { type ApiError, isAbortError, toApiError } from '@/api/errors';
import type { Asset, AssetQuery } from '@/lib/types';

/**
 * A loaded result set. `nextCursor` lives in the same object as the `query`
 * that produced it, and the next page is always requested with exactly that
 * pair — so a cursor can never be sent with a different query, and the API's
 * `400 stale_cursor` is unreachable rather than merely handled.
 */
export interface Results {
  key: string;
  query: AssetQuery;
  items: Asset[];
  total: number;
  nextCursor: string | null;
}

export interface SearchState {
  /** The query the user is asking for right now. */
  requestedKey: string;
  /** First-page status of `requestedKey`. */
  status: 'loading' | 'ready' | 'error';
  error: ApiError | null;
  /**
   * The last results that arrived. While `status` is 'loading' these may belong
   * to an older query (`results.key !== requestedKey`); the UI shows them as
   * visibly stale rather than blanking the grid on every search.
   */
  results: Results | null;
  more: 'idle' | 'loading' | 'error';
  moreError: ApiError | null;
}

export function useAssetSearch(query: AssetQuery) {
  const key = assetQueryKey(query);
  const [state, setState] = useState<SearchState>(() => ({
    requestedKey: key,
    status: 'loading',
    error: null,
    results: null,
    more: 'idle',
    moreError: null,
  }));
  const [attempt, setAttempt] = useState(0);

  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const moreRequest = useRef<{ controller: AbortController; cursor: string } | null>(null);

  // First page. `key` is a complete serialisation of `query`, so it is the only
  // dependency needed: a new key means a new result set.
  useEffect(() => {
    const controller = new AbortController();
    moreRequest.current?.controller.abort();
    moreRequest.current = null;

    setState((s) => ({
      ...s,
      requestedKey: key,
      status: 'loading',
      error: null,
      more: 'idle',
      moreError: null,
    }));

    listAssets(query, controller.signal).then(
      (page) => {
        // Two guards, deliberately redundant: the abort below already stops a
        // superseded response reaching here; the key check makes a stale write
        // impossible even if a future change breaks cancellation.
        setState((s) =>
          s.requestedKey !== key
            ? s
            : {
                ...s,
                status: 'ready',
                results: {
                  key,
                  query,
                  items: page.items,
                  total: page.total,
                  nextCursor: page.nextCursor,
                },
              },
        );
      },
      (err: unknown) => {
        if (isAbortError(err)) return;
        setState((s) =>
          s.requestedKey !== key ? s : { ...s, status: 'error', error: toApiError(err) },
        );
      },
    );

    return () => controller.abort();
  }, [key, attempt]);

  const loadMore = useCallback(() => {
    const s = stateRef.current;
    const results = s.results;
    if (s.status !== 'ready' || !results || results.key !== s.requestedKey) return;
    const cursor = results.nextCursor;
    if (!cursor || moreRequest.current?.cursor === cursor) return;

    const controller = new AbortController();
    moreRequest.current = { controller, cursor };
    setState((prev) => ({ ...prev, more: 'loading', moreError: null }));

    listAssets({ ...results.query, cursor }, controller.signal).then(
      (page) => {
        if (moreRequest.current?.controller === controller) moreRequest.current = null;
        setState((prev) => {
          const current = prev.results;
          if (!current || current.key !== results.key || current.nextCursor !== cursor) return prev;
          // Cursors are offsets. If a row was edited between pages it can move
          // across the page boundary and arrive twice; drop the repeat so React
          // keys stay unique.
          const seen = new Set(current.items.map((a) => a.id));
          const fresh = page.items.filter((a) => !seen.has(a.id));
          return {
            ...prev,
            more: 'idle',
            results: {
              ...current,
              items: current.items.concat(fresh),
              total: page.total,
              nextCursor: page.nextCursor,
            },
          };
        });
      },
      (err: unknown) => {
        if (moreRequest.current?.controller === controller) moreRequest.current = null;
        if (isAbortError(err)) return;
        const error = toApiError(err);
        if (error.code === 'stale_cursor') {
          // Unreachable by construction (see Results). If the server ever
          // disagrees, recover silently by reloading page one.
          setAttempt((n) => n + 1);
          return;
        }
        setState((prev) =>
          prev.results?.key !== results.key ? prev : { ...prev, more: 'error', moreError: error },
        );
      },
    );
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { ...state, loadMore, retry };
}
