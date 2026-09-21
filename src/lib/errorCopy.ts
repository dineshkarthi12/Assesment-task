import type { ApiError } from '@/api/errors';

export interface ErrorCopy {
  title: string;
  detail: string;
}

/**
 * What a person reads when something fails. Chosen by status and code, never by
 * the server's message, which is written for developers ("429: Too many
 * requests in the last 10 seconds") and is only ever logged.
 */
export function describeError(error: ApiError): ErrorCopy {
  if (error.status === 0) {
    return {
      title: 'Can’t reach MediaVault',
      detail: 'Check your connection, then try again.',
    };
  }
  // Reaching the user at all means the automatic retries (see http.ts) gave up.
  if (error.status === 429) {
    return {
      title: 'MediaVault is busy',
      detail: 'It’s still busy after a few automatic retries. Wait a moment, then try again.',
    };
  }
  if (error.code === 'legal_hold') {
    return {
      title: 'This asset is on legal hold',
      detail: 'Assets on legal hold can’t be archived. Other statuses are still allowed.',
    };
  }
  if (error.code === 'write_failed') {
    return {
      title: 'The change wasn’t saved',
      detail: 'Nothing was changed on the server. Trying again is safe.',
    };
  }
  if (error.status >= 500) {
    return {
      title: 'The library is temporarily unavailable',
      detail: 'This is usually brief. Try again in a moment.',
    };
  }
  if (error.status === 404) {
    return { title: 'Not found', detail: 'This asset may have been removed.' };
  }
  if (error.status === 409) {
    return {
      title: 'Someone else changed this asset',
      detail: 'Reload it to see the latest version before editing.',
    };
  }
  return {
    title: 'That didn’t work',
    detail: 'Try again. If it keeps happening, clear the filters and start over.',
  };
}
