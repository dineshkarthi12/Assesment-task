import { useCallback, useSyncExternalStore } from 'react';
import type { Asset, AssetStatus } from '@/lib/types';

/** Why a write did not apply to one asset. */
export interface WriteFailure {
  code: string;
  retryable: boolean;
}

interface Pending {
  status: AssetStatus;
  /** The write operation that set this. Only that operation may clear it. */
  opId: number;
}

/**
 * The client's record of writes, layered over whatever the list last fetched.
 *
 * What a card shows is resolved in three steps:
 *   1. the asset from the list page,
 *   2. replaced by a newer confirmed copy from a write response, if the
 *      server has returned one with a higher `version`,
 *   3. with any in-flight (optimistic) status on top.
 *
 * Optimistic state is the `pending` map, keyed by asset id and tagged with the
 * operation that wrote it. A rollback removes an entry only if its op id still
 * matches — so if a second change to the same asset starts while the first is
 * in flight, the first one's failure cannot undo the second.
 */
export interface AssetStore {
  view(asset: Asset): Asset;
  isPending(id: string): boolean;
  failure(id: string): WriteFailure | undefined;
  /** Marks `ids` as moving to `status` and returns the operation id. */
  beginWrite(ids: readonly string[], status: AssetStatus): number;
  /** Records a server-confirmed asset; clears the pending entry if it belongs to `opId`. */
  confirm(asset: Asset, opId?: number): void;
  /** Drops the pending entry if it belongs to `opId`, and records why. */
  rollback(id: string, opId: number, failure?: WriteFailure): void;
  subscribeId(id: string, onChange: () => void): () => void;
}

export function createAssetStore(): AssetStore {
  let nextOpId = 1;
  const confirmed = new Map<string, Asset>();
  const pending = new Map<string, Pending>();
  const failures = new Map<string, WriteFailure>();
  const listeners = new Map<string, Set<() => void>>();
  // Resolved views are cached so that useSyncExternalStore gets the same
  // object back until one of its inputs actually changes. Keyed by the source
  // object, not the id: a card and the detail panel can resolve the same id
  // from different source objects, and must not evict each other's entry
  // (that would hand back a new object on every call and loop the render).
  const views = new WeakMap<Asset, { conf?: Asset; pend?: Pending; out: Asset }>();

  const notify = (id: string) => listeners.get(id)?.forEach((cb) => cb());

  return {
    view(source) {
      const conf = confirmed.get(source.id);
      const pend = pending.get(source.id);
      const cached = views.get(source);
      if (cached && cached.conf === conf && cached.pend === pend) return cached.out;
      const base = conf && conf.version > source.version ? conf : source;
      const out = pend && pend.status !== base.status ? { ...base, status: pend.status } : base;
      views.set(source, { conf, pend, out });
      return out;
    },
    isPending: (id) => pending.has(id),
    failure: (id) => failures.get(id),

    beginWrite(ids, status) {
      const opId = nextOpId++;
      for (const id of ids) {
        pending.set(id, { status, opId });
        failures.delete(id);
        notify(id);
      }
      return opId;
    },
    confirm(asset, opId) {
      const known = confirmed.get(asset.id);
      if (!known || asset.version >= known.version) confirmed.set(asset.id, asset);
      if (opId !== undefined && pending.get(asset.id)?.opId === opId) pending.delete(asset.id);
      notify(asset.id);
    },
    rollback(id, opId, failure) {
      if (pending.get(id)?.opId !== opId) return;
      pending.delete(id);
      if (failure) failures.set(id, failure);
      notify(id);
    },

    subscribeId(id, onChange) {
      let set = listeners.get(id);
      if (!set) listeners.set(id, (set = new Set()));
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(id);
      };
    },
  };
}

function useAssetSubscription(store: AssetStore, id: string) {
  return useCallback((cb: () => void) => store.subscribeId(id, cb), [store, id]);
}

export function useAssetView(store: AssetStore, asset: Asset): Asset {
  const subscribe = useAssetSubscription(store, asset.id);
  return useSyncExternalStore(subscribe, () => store.view(asset));
}

export function useWriteState(store: AssetStore, id: string) {
  const subscribe = useAssetSubscription(store, id);
  const pending = useSyncExternalStore(subscribe, () => store.isPending(id));
  const failure = useSyncExternalStore(subscribe, () => store.failure(id));
  return { pending, failure };
}
