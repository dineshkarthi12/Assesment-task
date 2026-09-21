import { ApiError, NETWORK_ERROR, abortError, isRetryable, parseRetryAfter } from './errors';
import { reportRateLimited, reportUnreachable, sleep, waitUntilClear } from './network';

interface SendInit {
  method: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  signal: AbortSignal;
}

/** One network round trip. Turns every outcome into a value, an ApiError, or an AbortError. */
async function send<T>(path: string, { method, body, signal }: SendInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (signal.aborted) throw abortError();
    throw new ApiError({
      status: 0,
      code: NETWORK_ERROR,
      message: err instanceof Error ? err.message : 'Network request failed',
    });
  }

  const requestId = res.headers.get('x-request-id');
  try {
    if (res.ok) return (await res.json()) as T;

    let code = `http_${res.status}`;
    let message = res.statusText;
    try {
      const payload = (await res.json()) as { error?: { code?: string; message?: string } };
      code = payload.error?.code ?? code;
      message = payload.error?.message ?? message;
    } catch {
      /* error body was not JSON; keep the status-derived code */
    }
    throw new ApiError({
      status: res.status,
      code,
      message,
      requestId,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    });
  } catch (err) {
    if (signal.aborted) throw abortError();
    if (err instanceof ApiError) throw err;
    throw new ApiError({ status: res.status, code: 'bad_response', message: String(err), requestId });
  }
}

/* ------------------------------------------------------------------ *
 * Retry
 * ------------------------------------------------------------------ */

/** One try plus three retries. Every retry counts against the 80-per-10s budget. */
export const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8000;

/**
 * `Retry-After` wins when the server sends one (503 → 2s, 429 → 3s); a little
 * jitter stops many clients returning in lockstep. Otherwise exponential with
 * "equal jitter": between half and all of 500ms, 1s, 2s…, capped at 8s. Equal
 * rather than full jitter, so a retry is never fired almost immediately.
 */
export function backoffDelay(attempt: number, error: ApiError, random = Math.random): number {
  if (error.retryAfterMs !== null) return error.retryAfterMs + random() * 250;
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return ceiling / 2 + random() * (ceiling / 2);
}

/**
 * Sends with retries. What is retried is decided by `isRetryable` — by status,
 * never by message: no response, 408, 429 and 5xx are; 400, 404, 409 and 422
 * are returned to the caller on the first attempt.
 *
 * Every attempt first waits for the shared gate (connected, not rate limited),
 * so waiting out an outage costs no attempts, and one 429 pauses all requests.
 *
 * Replaying the writes is safe for this API: PATCH carries `version`, so a
 * replay of a write that did land comes back as 409 (handled by the caller),
 * and bulk-status sets a value rather than changing one, so it is idempotent.
 */
async function sendWithRetry<T>(path: string, init: SendInit): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    await waitUntilClear(init.signal);
    try {
      return await send<T>(path, init);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err; // cancelled
      if (err.status === 0) reportUnreachable();
      if (err.status === 429) reportRateLimited(err.retryAfterMs ?? 3000);
      if (!isRetryable(err) || attempt >= MAX_ATTEMPTS) throw err;
      await sleep(backoffDelay(attempt, err), init.signal);
    }
  }
}

/* ------------------------------------------------------------------ *
 * De-duplicated GET
 * ------------------------------------------------------------------ */

interface InFlight {
  promise: Promise<unknown>;
  controller: AbortController;
  subscribers: number;
}

const inFlight = new Map<string, InFlight>();

/**
 * Concurrent GETs for the same path share one network request. Each caller
 * passes its own AbortSignal and is released the moment it aborts; the shared
 * request is only cancelled once every caller has left.
 *
 * That cancellation is deferred by a microtask, so a caller that leaves and
 * immediately rejoins — React StrictMode's mount → unmount → mount — picks the
 * same request back up instead of firing a second one.
 */
export function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let entry = inFlight.get(path);
  if (!entry) {
    const controller = new AbortController();
    const created: InFlight = {
      controller,
      subscribers: 0,
      promise: sendWithRetry<T>(path, { method: 'GET', signal: controller.signal }),
    };
    const forget = () => {
      if (inFlight.get(path) === created) inFlight.delete(path);
    };
    created.promise.then(forget, forget);
    inFlight.set(path, created);
    entry = created;
  }
  return join(path, entry, signal) as Promise<T>;
}

function join(path: string, entry: InFlight, signal: AbortSignal | undefined): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(abortError());
  entry.subscribers += 1;

  return new Promise((resolve, reject) => {
    const leave = () => {
      signal?.removeEventListener('abort', onAbort);
      entry.subscribers -= 1;
    };
    const onAbort = () => {
      leave();
      reject(abortError());
      queueMicrotask(() => {
        if (entry.subscribers === 0 && inFlight.get(path) === entry) {
          inFlight.delete(path);
          entry.controller.abort();
        }
      });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // If the caller aborted first, onAbort has already settled this promise and
    // released the subscription; the shared result is simply not delivered.
    entry.promise.then(
      (value) => {
        if (signal?.aborted) return;
        leave();
        resolve(value);
      },
      (err: unknown) => {
        if (signal?.aborted) return;
        leave();
        reject(err);
      },
    );
  });
}

/** Writes are never de-duplicated: two identical PATCHes are two intents. They are retried (see sendWithRetry). */
export function write<T>(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return sendWithRetry<T>(path, { method, body, signal: signal ?? new AbortController().signal });
}
