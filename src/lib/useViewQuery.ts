import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { parseViewQuery, serializeViewQuery, type ViewQuery } from './viewQuery';

/**
 * How a change is recorded in history.
 *   'replace' — typing in the search box: rewrites the current entry, so Back
 *               does not walk through every keystroke.
 *   'push'    — a discrete choice (a filter, a sort): one entry per decision,
 *               so Back undoes the last one.
 */
export type HistoryMode = 'push' | 'replace';

const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('popstate', onChange);
  };
}

const getSnapshot = () => window.location.search;

/**
 * The URL is the single source of truth for the view. There is no parallel
 * React state to keep in sync with it: components read the parsed URL and
 * write back to it, and Back/Forward just work.
 */
export function useViewQuery() {
  const search = useSyncExternalStore(subscribe, getSnapshot);
  const view = useMemo(() => parseViewQuery(search), [search]);

  const updateView = useCallback((change: (prev: ViewQuery) => ViewQuery, mode: HistoryMode) => {
    // Read the live URL, not a render-time snapshot, so two updates in one tick compose.
    const next = change(parseViewQuery(window.location.search));
    const qs = serializeViewQuery(next);
    const url = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    if (url === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
    listeners.forEach((notify) => notify());
  }, []);

  return [view, updateView] as const;
}
