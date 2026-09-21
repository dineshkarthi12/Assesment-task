/**
 * Every failure the client surfaces is an ApiError. Callers branch on `status`
 * and `code` (the server's `{ error: { code } }`), never on `message` — the
 * message is for logs, not for control flow and not for users.
 */
export class ApiError extends Error {
  /** HTTP status, or 0 when no HTTP response arrived at all. */
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    requestId?: string | null;
    retryAfterMs?: number | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.retryAfterMs = init.retryAfterMs ?? null;
  }
}

/** Synthetic code for "the request never got an HTTP response". */
export const NETWORK_ERROR = 'network_error';

export function abortError(): DOMException {
  return new DOMException('The request was cancelled.', 'AbortError');
}

/**
 * Cancellation is not a failure: it means a newer request superseded this one.
 * Every catch site checks this first and does nothing.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Whether repeating the same request could succeed. Decided by status alone:
 * no response, rate limiting and server errors are transient; every 4xx
 * (400 bad request, 404, 409 conflict, 422 validation) will fail the same way
 * again.
 */
export function isRetryable(error: ApiError): boolean {
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500;
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError({
    status: 0,
    code: 'unknown',
    message: err instanceof Error ? err.message : String(err),
  });
}

/** `Retry-After` may be delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}
