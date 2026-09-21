import { useCallback, useSyncExternalStore } from 'react';

/**
 * Selection lives outside React state so that toggling one card re-renders
 * that card and nothing else. Each card subscribes to its own id and reads a
 * boolean; the bulk bar subscribes to the count. Nobody holds the Set itself,
 * so a toggle never hands every card a new prop.
 */
export interface SelectionStore {
  has(id: string): boolean;
  size(): number;
  ids(): string[];
  toggle(id: string): void;
  /** Sets many ids at once with one notification per changed id. */
  setMany(ids: readonly string[], selected: boolean): void;
  clear(): void;
  /** The id a Shift-click range extends from: the last one clicked. */
  anchor: string | null;
  /** Notified when this id's membership changes. */
  subscribeId(id: string, onChange: () => void): () => void;
  /** Notified on any change. */
  subscribe(onChange: () => void): () => void;
}

export function createSelectionStore(): SelectionStore {
  let selected = new Set<string>();
  const byId = new Map<string, Set<() => void>>();
  const anyChange = new Set<() => void>();

  function notify(ids: Iterable<string>) {
    for (const id of ids) byId.get(id)?.forEach((cb) => cb());
    anyChange.forEach((cb) => cb());
  }

  return {
    anchor: null,
    has: (id) => selected.has(id),
    size: () => selected.size,
    ids: () => [...selected],
    toggle(id) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      notify([id]);
    },
    setMany(ids, on) {
      const changed: string[] = [];
      for (const id of ids) {
        if (selected.has(id) === on) continue;
        if (on) selected.add(id);
        else selected.delete(id);
        changed.push(id);
      }
      if (changed.length) notify(changed);
    },
    clear() {
      this.anchor = null;
      if (selected.size === 0) return;
      const previous = selected;
      selected = new Set();
      notify(previous);
    },
    subscribeId(id, onChange) {
      let listeners = byId.get(id);
      if (!listeners) byId.set(id, (listeners = new Set()));
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) byId.delete(id);
      };
    },
    subscribe(onChange) {
      anyChange.add(onChange);
      return () => anyChange.delete(onChange);
    },
  };
}

export function useIsSelected(store: SelectionStore, id: string): boolean {
  const subscribe = useCallback((cb: () => void) => store.subscribeId(id, cb), [store, id]);
  return useSyncExternalStore(subscribe, () => store.has(id));
}

export function useSelectionCount(store: SelectionStore): number {
  return useSyncExternalStore(store.subscribe, store.size);
}
