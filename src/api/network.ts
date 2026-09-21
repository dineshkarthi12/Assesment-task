import { useSyncExternalStore } from 'react';
import { abortError } from './errors';

/**
 * Connection state shared by every request. Each attempt waits in
 * `waitUntilClear` before it is sent, so the client as a whole stops when the
 * network is gone or the server has rate limited us, rather than each request
 * discovering that for itself — which is how a retry storm starts.
 */
export interface NetworkState {
  /** False while offline, or after a request failed to connect until a health probe succeeds. */
  reachable: boolean;
  /** The browser's own view. Distinguishes "you're offline" from "the server can't be reached". */
  browserOnline: boolean;
  /** Epoch ms until which every request is held after a 429; 0 when not paused. */
  pausedUntil: number;
}

const hasWindow = typeof window !== 'undefined';
/** Only an explicit `false` means offline; some environments have a `navigator` without `onLine`. */
const browserSaysOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const initiallyOnline = browserSaysOnline();

let state: NetworkState = {
  reachable: initiallyOnline,
  browserOnline: initiallyOnline,
  pausedUntil: 0,
};
const listeners = new Set<() => void>();
let waiters = new Set<() => void>();

function update(patch: Partial<NetworkState>) {
  state = { ...state, ...patch };
  listeners.forEach((notify) => notify());
  const woken = waiters;
  waiters = new Set();
  woken.forEach((wake) => wake());
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function nextChange(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onChange = () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      waiters.delete(onChange);
      reject(abortError());
    };
    waiters.add(onChange);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Resolves when a request may be sent: connected and not rate limited. Rejects on abort. */
export async function waitUntilClear(signal: AbortSignal): Promise<void> {
  for (;;) {
    if (signal.aborted) throw abortError();
    if (!state.reachable) {
      await nextChange(signal);
      continue;
    }
    const wait = state.pausedUntil - Date.now();
    if (wait > 0) {
      // A little jitter so everything held by the pause does not fire in the same millisecond.
      await sleep(wait + Math.random() * 250, signal);
      continue;
    }
    return;
  }
}

/** A request failed without any HTTP response. */
export function reportUnreachable() {
  if (!state.reachable) return;
  update({ reachable: false, browserOnline: browserSaysOnline() });
  void probeUntilReachable();
}

/** The server said 429: hold every request, not just this one, for `ms`. */
export function reportRateLimited(ms: number) {
  const until = Date.now() + ms;
  if (until <= state.pausedUntil) return;
  update({ pausedUntil: until });
  setTimeout(() => {
    if (Date.now() >= state.pausedUntil) update({ pausedUntil: 0 });
  }, ms + 10);
}

/* ------------------------------------------------------------------ *
 * Recovery: poll /api/health (never rate limited) with backoff, and
 * immediately when the browser says it is back online.
 * ------------------------------------------------------------------ */

// /api/health is never rate limited or delayed, so probing is free against the
// budget. The cap bounds how long recovery can lag behind the connection
// coming back (measured 5.9s with an 8s cap), without polling every second.
const PROBE_FIRST_MS = 1000;
const PROBE_MAX_MS = 4000;
let probing = false;
let kickProbe: (() => void) | null = null;

async function probeUntilReachable() {
  if (probing) return;
  probing = true;
  let delay = PROBE_FIRST_MS;
  while (!state.reachable) {
    await new Promise<void>((resolve) => {
      kickProbe = resolve;
      setTimeout(resolve, delay);
    });
    kickProbe = null;
    if (!browserSaysOnline()) continue; // no point asking; wait for the 'online' event
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (res.ok) update({ reachable: true, browserOnline: true });
    } catch {
      /* still unreachable */
    }
    delay = Math.min(delay * 2, PROBE_MAX_MS);
  }
  probing = false;
}

if (hasWindow) {
  window.addEventListener('offline', () => {
    update({ reachable: false, browserOnline: false });
    void probeUntilReachable();
  });
  window.addEventListener('online', () => {
    update({ browserOnline: true });
    kickProbe?.();
  });
  if (!initiallyOnline) void probeUntilReachable();
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function getNetworkState(): NetworkState {
  return state;
}

export function useNetworkState(): NetworkState {
  return useSyncExternalStore(subscribe, getNetworkState);
}
