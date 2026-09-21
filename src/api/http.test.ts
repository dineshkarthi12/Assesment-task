import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type HttpModule = typeof import('./http');
type ErrorsModule = typeof import('./errors');
type NetworkModule = typeof import('./network');

interface Call {
  url: string;
  method: string;
  signal: AbortSignal;
  respond: (status: number, body: unknown, headers?: Record<string, string>) => void;
  dropConnection: () => void;
}

let calls: Call[];
let healthUp: boolean;
let http: HttpModule;
let errors: ErrorsModule;
let network: NetworkModule;

// Fresh modules per test: network.ts holds shared connection state by design.
beforeEach(async () => {
  vi.resetModules();
  calls = [];
  healthUp = true;
  vi.stubGlobal('fetch', (url: string, init: RequestInit = {}) => {
    if (url === '/api/health') {
      return healthUp
        ? Promise.resolve(new Response('{"ok":true}', { status: 200 }))
        : Promise.reject(new TypeError('Failed to fetch'));
    }
    const signal = init.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      calls.push({
        url,
        method: init.method ?? 'GET',
        signal,
        respond: (status, body, headers) =>
          resolve(new Response(JSON.stringify(body), { status, headers })),
        dropConnection: () => reject(new TypeError('Failed to fetch')),
      });
    });
  });
  http = await import('./http');
  errors = await import('./errors');
  network = await import('./network');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Every request awaits the connection gate before fetch, so let microtasks run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('get() de-duplication and cancellation', () => {
  it('sends one request for concurrent identical GETs', async () => {
    const a = http.get('/api/assets?q=x');
    const b = http.get('/api/assets?q=x');
    await settle();
    expect(calls).toHaveLength(1);
    calls[0]!.respond(200, { n: 1 });
    await expect(a).resolves.toEqual({ n: 1 });
    await expect(b).resolves.toEqual({ n: 1 });
  });

  it('keeps the shared request alive while any caller still wants it', async () => {
    const leaving = new AbortController();
    const a = http.get('/api/assets?q=x', leaving.signal).catch((e) => e);
    const b = http.get('/api/assets?q=x');
    await settle();
    leaving.abort();
    await settle();

    expect(errors.isAbortError(await a)).toBe(true);
    expect(calls[0]!.signal.aborted).toBe(false);
    calls[0]!.respond(200, { n: 1 });
    await expect(b).resolves.toEqual({ n: 1 });
  });

  it('cancels the network request once every caller has aborted', async () => {
    const one = new AbortController();
    const two = new AbortController();
    const a = http.get('/api/assets?q=x', one.signal).catch((e) => e);
    const b = http.get('/api/assets?q=x', two.signal).catch((e) => e);
    await settle();
    one.abort();
    two.abort();
    await settle();

    expect(calls[0]!.signal.aborted).toBe(true);
    expect(errors.isAbortError(await a)).toBe(true);
    expect(errors.isAbortError(await b)).toBe(true);
  });

  it('lets a caller that leaves and rejoins in the same tick reuse the request (StrictMode)', async () => {
    const first = new AbortController();
    http.get('/api/assets?q=x', first.signal).catch(() => {});
    first.abort(); // StrictMode: effect cleanup…
    const again = http.get('/api/assets?q=x'); // …then the effect runs again, synchronously
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal.aborted).toBe(false);
    calls[0]!.respond(200, { n: 1 });
    await expect(again).resolves.toEqual({ n: 1 });
  });

  it('turns an error body into an ApiError carrying status and code', async () => {
    const pending = http.get('/api/assets/a_00001').catch((e) => e);
    await settle();
    calls[0]!.respond(409, { error: { code: 'version_conflict', message: 'Changed.' } });
    const error = await pending;
    expect(error).toBeInstanceOf(errors.ApiError);
    expect(error).toMatchObject({ status: 409, code: 'version_conflict' });
  });

  it('sends a fresh request once the previous one has settled', async () => {
    const a = http.get('/api/facets');
    await settle();
    calls[0]!.respond(200, {});
    await a;
    http.get('/api/facets').catch(() => {});
    await settle();
    expect(calls).toHaveLength(2);
  });
});

describe('retry policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it('waits out Retry-After on a 503, then retries and succeeds', async () => {
    const pending = http.get('/api/assets?q=x');
    await advance(0);
    calls[0]!.respond(503, { error: { code: 'upstream_unavailable' } }, { 'retry-after': '2' });

    await advance(1990);
    expect(calls).toHaveLength(1); // not before the server said
    await advance(300);
    expect(calls).toHaveLength(2);
    calls[1]!.respond(200, { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it.each([400, 404, 409, 422])('never retries a %i', async (status) => {
    const pending = http.write('/api/assets/a_00001', 'PATCH', { version: 1 }).catch((e) => e);
    await advance(0);
    calls[0]!.respond(status, { error: { code: `code_${status}` } });
    const error = await pending;
    await advance(20_000);
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ status });
  });

  it('retries a failed write (500 write_failed) — PATCH is safe to replay because it carries a version', async () => {
    const pending = http.write('/api/assets/a_00001', 'PATCH', { version: 1 });
    await advance(0);
    calls[0]!.respond(500, { error: { code: 'write_failed' } });
    await advance(600);
    expect(calls).toHaveLength(2);
    calls[1]!.respond(200, { id: 'a_00001', version: 2 });
    await expect(pending).resolves.toEqual({ id: 'a_00001', version: 2 });
  });

  it(`gives up after ${4} attempts`, async () => {
    const pending = http.get('/api/assets?q=x').catch((e) => e);
    for (let attempt = 0; attempt < 4; attempt++) {
      await advance(8_000);
      calls[attempt]!.respond(503, { error: { code: 'upstream_unavailable' } });
    }
    const error = await pending;
    await advance(20_000);
    expect(http.MAX_ATTEMPTS).toBe(4);
    expect(calls).toHaveLength(4);
    expect(error).toMatchObject({ status: 503 });
  });

  it('holds every request after a 429, not just the one that got it', async () => {
    const first = http.get('/api/assets?q=a');
    await advance(0);
    calls[0]!.respond(429, { error: { code: 'rate_limited' } }, { 'retry-after': '3' });
    await advance(0);

    const second = http.get('/api/assets?q=b');
    await advance(2_900);
    expect(calls.map((c) => c.url)).toEqual(['/api/assets?q=a']); // nothing else sent
    await advance(700);
    expect(calls.map((c) => c.url).sort()).toEqual([
      '/api/assets?q=a',
      '/api/assets?q=a',
      '/api/assets?q=b',
    ]);
    calls.slice(1).forEach((c) => c.respond(200, { url: c.url }));
    await expect(first).resolves.toEqual({ url: '/api/assets?q=a' });
    await expect(second).resolves.toEqual({ url: '/api/assets?q=b' });
  });

  it('stops sending while unreachable, then resumes once the health check passes', async () => {
    healthUp = false;
    const first = http.get('/api/assets?q=a');
    await advance(0);
    calls[0]!.dropConnection();
    await advance(0);
    expect(network.getNetworkState().reachable).toBe(false);

    const second = http.get('/api/assets?q=b');
    await advance(10_000); // probes keep failing: nothing is sent
    expect(calls).toHaveLength(1);

    healthUp = true;
    await advance(8_000); // next probe succeeds
    expect(network.getNetworkState().reachable).toBe(true);
    await advance(1_000);
    expect(calls.map((c) => c.url).sort()).toEqual([
      '/api/assets?q=a',
      '/api/assets?q=a',
      '/api/assets?q=b',
    ]);
    calls.slice(1).forEach((c) => c.respond(200, { url: c.url }));
    await expect(first).resolves.toEqual({ url: '/api/assets?q=a' });
    await expect(second).resolves.toEqual({ url: '/api/assets?q=b' });
  });
});

describe('backoffDelay', () => {
  const noRetryAfter = () =>
    new errors.ApiError({ status: 503, code: 'upstream_unavailable', message: '' });

  it('grows exponentially, never below half its ceiling, capped at 8s', () => {
    const bounds = (attempt: number) => [
      http.backoffDelay(attempt, noRetryAfter(), () => 0),
      http.backoffDelay(attempt, noRetryAfter(), () => 1),
    ];
    expect(bounds(1)).toEqual([250, 500]);
    expect(bounds(2)).toEqual([500, 1000]);
    expect(bounds(3)).toEqual([1000, 2000]);
    expect(bounds(10)).toEqual([4000, 8000]);
  });

  it('honours Retry-After, plus at most 250ms of jitter', () => {
    const e = new errors.ApiError({ status: 429, code: 'rate_limited', message: '', retryAfterMs: 3000 });
    expect(http.backoffDelay(1, e, () => 0)).toBe(3000);
    expect(http.backoffDelay(1, e, () => 1)).toBe(3250);
  });
});
