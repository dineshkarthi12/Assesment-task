import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNetworkState } from '@/api/network';
import { Announcer, announce } from '@/components/Announcer';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Icon } from '@/components/Icon';
import { NetworkBanner } from '@/components/NetworkBanner';
import { describeError } from '@/lib/errorCopy';
import { AssetDetail } from '@/features/assets/AssetDetail';
import { AssetGrid, type AssetGridHandle } from '@/features/assets/AssetGrid';
import { createAssetStore } from '@/features/assets/assetStore';
import { EmptyState, ErrorState, LoadingState } from '@/features/assets/ResultStates';
import { useAssetSearch, type SearchState } from '@/features/assets/useAssetSearch';
import { BulkBar, BulkReport, summarizeOutcome, type BulkState } from '@/features/bulk/BulkPanel';
import { BULK_BATCH_SIZE, runBulkStatus } from '@/features/bulk/bulkStatus';
import { FilterBar } from '@/features/search/FilterBar';
import { SearchBox } from '@/features/search/SearchBox';
import { createSelectionStore, useSelectionCount } from '@/features/selection/selectionStore';
import { statusLabel } from '@/lib/format';
import type { Asset, AssetStatus } from '@/lib/types';
import { useViewQuery } from '@/lib/useViewQuery';
import { EMPTY_VIEW, hasFilters, toAssetQuery } from '@/lib/viewQuery';

const NO_ASSETS: Asset[] = [];

/**
 * How long the previous query's rows may stay on screen (dimmed, marked busy)
 * while a new search loads. The API's slowest ordinary response is a 1–2
 * character query at about 1.2s, so normal searches never flicker to a
 * loading state; a retry or an outage does.
 */
const STALE_ROWS_MAX_MS = 1500;

export function App() {
  const [view, updateView] = useViewQuery();
  const query = useMemo(() => toAssetQuery(view), [view]);
  const search = useAssetSearch(query);

  const [selection] = useState(createSelectionStore);
  const [assetStore] = useState(createAssetStore);
  const selectedCount = useSelectionCount(selection);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkState | null>(null);
  const { reachable, browserOnline } = useNetworkState();

  const gridRef = useRef<AssetGridHandle>(null);
  const mainRef = useRef<HTMLElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);

  const items = search.results?.items ?? NO_ASSETS;
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // A selection belongs to the result set it was made in. Keeping it across a
  // new search would let a bulk action hit assets the user can no longer see.
  useEffect(() => {
    selection.clear();
  }, [search.requestedKey, selection]);

  // Coming back online: anything that gave up while the connection was down tries again by itself.
  const { status: searchStatus, more: moreStatus, retry: retrySearch, loadMore } = search;
  useEffect(() => {
    if (!reachable) return;
    if (searchStatus === 'error') retrySearch();
    else if (moreStatus === 'error') loadMore();
    // Only on the transition to reachable, not whenever a status changes.
  }, [reachable]);

  const commitSearch = useCallback(
    (q: string) => updateView((prev) => ({ ...prev, q }), 'replace'),
    [updateView],
  );
  const clearFilters = useCallback(
    () => updateView((prev) => ({ ...EMPTY_VIEW, sort: prev.sort }), 'push'),
    [updateView],
  );

  /** Click toggles; Shift-click applies the anchor's state to everything between. */
  const onCheck = useCallback(
    (id: string, extend: boolean) => {
      const list = itemsRef.current;
      const anchor = selection.anchor;
      const from = extend && anchor ? list.findIndex((a) => a.id === anchor) : -1;
      const to = from >= 0 ? list.findIndex((a) => a.id === id) : -1;
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        selection.setMany(
          list.slice(lo, hi + 1).map((a) => a.id),
          selection.has(anchor as string),
        );
      } else {
        selection.toggle(id);
      }
      selection.anchor = id;
    },
    [selection],
  );

  const selectAllLoaded = useCallback(() => {
    selection.setMany(
      itemsRef.current.map((a) => a.id),
      true,
    );
    announce(`${itemsRef.current.length.toLocaleString()} selected`);
  }, [selection]);

  /* ---------------------------------------------------------------- *
   * Detail panel: focus in on open, back to the card on close.
   * ---------------------------------------------------------------- */

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  const closePanel = useCallback(() => {
    const closing = activeIdRef.current;
    setActiveId(null);
    if (!closing) return;
    // Two frames: the grid widens when the panel goes, and re-lays out in a
    // ResizeObserver callback; focus the card once that layout is in place.
    // If the card was filtered out meanwhile, focusAsset picks the nearest one.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!gridRef.current?.focusAsset(closing)) resultsHeadingRef.current?.focus();
      }),
    );
  }, []);

  useEffect(() => {
    if (!activeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Escape in a search box with text clears it first, as the browser intends.
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement && target.type === 'search' && target.value) return;
      closePanel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeId, closePanel]);

  // If the element holding focus inside the results is removed (the grid is
  // replaced by a loading or error state, say), focus would fall to <body>.
  // Put it somewhere meaningful instead. Only acts when the element was
  // actually detached, not when the user clicked elsewhere.
  useEffect(() => {
    const onFocusOut = (e: FocusEvent) => {
      const lost = e.target as HTMLElement;
      if (!mainRef.current?.contains(lost)) return;
      requestAnimationFrame(() => {
        if (lost.isConnected) return;
        const active = document.activeElement;
        if (active && active !== document.body) return;
        if (!gridRef.current?.focusCurrent()) resultsHeadingRef.current?.focus();
      });
    };
    document.addEventListener('focusout', onFocusOut, true);
    return () => document.removeEventListener('focusout', onFocusOut, true);
  }, []);

  /* ---------------------------------------------------------------- *
   * Bulk
   * ---------------------------------------------------------------- */

  async function applyStatus(ids: string[], status: AssetStatus, knownNames?: ReadonlyMap<string, string>) {
    if (ids.length === 0 || bulk?.phase === 'running') return;
    // Capture names now: the list may change (a new search) before results
    // come back, and the report must still say which assets failed.
    const names = new Map(knownNames);
    for (const a of itemsRef.current) names.set(a.id, a.name);

    selection.clear();
    setBulk({
      phase: 'running',
      status,
      count: ids.length,
      batchesDone: 0,
      batchesTotal: Math.ceil(ids.length / BULK_BATCH_SIZE),
    });
    announce(`Moving ${ids.length.toLocaleString()} ${ids.length === 1 ? 'asset' : 'assets'} to ${statusLabel(status)}…`);
    const outcome = await runBulkStatus(ids, status, {
      store: assetStore,
      onProgress: (batchesDone, batchesTotal) =>
        setBulk({ phase: 'running', status, count: ids.length, batchesDone, batchesTotal }),
    });
    setBulk({ phase: 'done', outcome, names });
    announce(summarizeOutcome(outcome), outcome.failed.length ? 'assertive' : 'polite');
  }

  /* ---------------------------------------------------------------- *
   * Announcements: outcomes, not progress
   * ---------------------------------------------------------------- */

  const { status, results, error, more, moreError } = search;

  // Result count once per completed search — typing is debounced upstream,
  // and this fires on arrival of a new result set, never per keystroke.
  const announcedKey = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'ready' || !results || results.key !== search.requestedKey) return;
    if (announcedKey.current === results.key) return;
    announcedKey.current = results.key;
    const n = results.total;
    const q = view.q.trim();
    announce(
      n === 0
        ? 'No assets match these filters'
        : `${n.toLocaleString()} ${n === 1 ? 'asset' : 'assets'}${q ? ` matching “${q}”` : ''}`,
    );
  }, [status, results, search.requestedKey, view.q]);

  useEffect(() => {
    if (status === 'error' && error) {
      const copy = describeError(error);
      announce(`${copy.title}. ${copy.detail}`, 'assertive');
    }
  }, [status, error]);

  useEffect(() => {
    if (more === 'error' && moreError) {
      announce(`Couldn’t load more assets. ${describeError(moreError).detail}`);
    }
  }, [more, moreError]);

  const wasReachable = useRef(reachable);
  useEffect(() => {
    if (wasReachable.current === reachable) return;
    wasReachable.current = reachable;
    if (!reachable) {
      announce(
        `${browserOnline ? 'Can’t reach MediaVault' : 'You’re offline'}. Changes you make will be sent when the connection is back.`,
        'assertive',
      );
    } else {
      announce('Back online.');
    }
  }, [reachable, browserOnline]);

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  // Loading with results on screen means those rows belong to the previous
  // query (or are being refreshed after a retry). They stay visible — blanking
  // the grid on every search is the flicker the brief warns about — but are
  // dimmed, marked busy, and the count says "Searching…", so nothing on screen
  // claims to answer the new query until the new answer has arrived.
  const refreshing = status === 'loading' && results !== null;

  // …but only for as long as an ordinary response takes. A retry (Retry-After
  // is 2–3s) or an outage can keep a search loading for much longer, and old
  // rows should not stand in for an answer that long.
  const [staleExpired, setStaleExpired] = useState(false);
  useEffect(() => {
    if (status !== 'loading') {
      setStaleExpired(false);
      return;
    }
    const timer = window.setTimeout(() => setStaleExpired(true), STALE_ROWS_MAX_MS);
    return () => window.clearTimeout(timer);
  }, [status, search.requestedKey]);

  let body: ReactNode;
  if (status === 'error' && error) {
    body = <ErrorState error={error} onRetry={search.retry} />;
  } else if (!results || (refreshing && (results.items.length === 0 || staleExpired))) {
    body = <LoadingState />;
  } else if (status === 'ready' && results.items.length === 0) {
    body = <EmptyState filtered={hasFilters(view)} onClear={clearFilters} />;
  } else {
    body = (
      <AssetGrid
        ref={gridRef}
        assets={results.items}
        total={results.total}
        resultKey={results.key}
        hasMore={results.nextCursor !== null && more !== 'error'}
        stale={refreshing}
        activeId={activeId}
        selection={selection}
        assetStore={assetStore}
        onOpen={setActiveId}
        onCheck={onCheck}
        onNearEnd={search.loadMore}
        footer={refreshing ? null : <ListFooter search={search} onRetry={search.loadMore} />}
      />
    );
  }

  return (
    <div className="app">
      <Announcer />
      {/* First Tab stop: the filters are up to ten stops between the search box and the grid. */}
      <a
        className="skip-link"
        href="#results"
        onClick={(e) => {
          e.preventDefault();
          if (!gridRef.current?.focusCurrent()) resultsHeadingRef.current?.focus();
        }}
      >
        Skip to results
      </a>
      <header className="topbar">
        <h1>MediaVault</h1>
        <SearchBox value={view.q} onCommit={commitSearch} />
        <p className="topbar__count">
          {status === 'loading'
            ? 'Searching…'
            : status === 'ready' && results
              ? `${results.total.toLocaleString()} ${results.total === 1 ? 'asset' : 'assets'}`
              : ''}
        </p>
        {status === 'ready' && items.length > 0 && selectedCount === 0 && (
          <button type="button" className="button button--quiet" onClick={selectAllLoaded}>
            Select all {items.length.toLocaleString()} loaded
          </button>
        )}
      </header>

      <NetworkBanner />
      <FilterBar view={view} updateView={updateView} />

      {selectedCount > 0 && (
        <BulkBar
          count={selectedCount}
          loadedCount={items.length}
          busy={bulk?.phase === 'running'}
          onApply={(s) => applyStatus(selection.ids(), s)}
          onSelectAll={selectAllLoaded}
          onClear={() => {
            selection.clear();
            announce('Selection cleared');
          }}
        />
      )}
      {bulk && (
        <BulkReport
          state={bulk}
          onRetry={(ids, s) => applyStatus(ids, s, bulk.phase === 'done' ? bulk.names : undefined)}
          onDismiss={() => setBulk(null)}
        />
      )}

      <main className="content" ref={mainRef}>
        <h2 id="results" className="visually-hidden" tabIndex={-1} ref={resultsHeadingRef}>
          Results
        </h2>
        <ErrorBoundary
          // Reset on a new request *and* on new results: while a new search
          // loads, the previous (possibly broken) rows are still shown, so
          // resetting on the request alone would just crash again and then
          // never reset when the good results arrive.
          resetKey={`${search.requestedKey}|${results?.key ?? ''}`}
          fallback={(reset) => (
            <div className="state state--error" role="alert">
              <Icon name="alert" />
              <p className="state__title">The asset list couldn’t be displayed</p>
              <p className="state__detail">Your filters are kept. Try again, or change the search.</p>
              <button type="button" className="button button--primary" onClick={reset}>
                Try again
              </button>
            </div>
          )}
        >
          {body}
        </ErrorBoundary>
        {activeId && (
          <ErrorBoundary
            resetKey={activeId}
            fallback={() => (
              <aside className="panel" aria-label="Asset detail" role="alert">
                <p className="state__title">This asset couldn’t be displayed</p>
                <p className="state__detail">The rest of the library is unaffected.</p>
                <button type="button" className="button" onClick={closePanel}>
                  Close panel
                </button>
              </aside>
            )}
          >
            <AssetDetail id={activeId} assets={assetStore} onClose={closePanel} />
          </ErrorBoundary>
        )}
      </main>
    </div>
  );
}

/** Only the end of the list and a failed page need words; loading shows as skeleton cards. */
function ListFooter({ search, onRetry }: { search: SearchState; onRetry: () => void }) {
  const { results, more, moreError } = search;
  if (!results) return null;

  if (more === 'error' && moreError) {
    const copy = describeError(moreError);
    return (
      <div className="list-footer">
        <span>Couldn’t load more assets. {copy.detail}</span>
        <button type="button" className="button button--primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }
  if (results.nextCursor) return null;
  return (
    <p className="list-footer">
      End of results · {results.total.toLocaleString()}{' '}
      {results.total === 1 ? 'asset' : 'assets'}
    </p>
  );
}
