import { useSyncExternalStore } from 'react';

/**
 * One pair of live regions for the whole app, always in the DOM. Regions that
 * are inserted already holding text are announced unreliably, and several
 * regions competing make screen readers talk over themselves — so components
 * do not carry their own role="status"; they call `announce()`.
 *
 * Callers announce outcomes, not progress: a finished search's count (once,
 * not per keystroke), a bulk result, an error, a connection change.
 */
type Politeness = 'polite' | 'assertive';

let messages: Record<Politeness, string> = { polite: '', assertive: '' };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function announce(text: string, politeness: Politeness = 'polite') {
  // Clear first, then set on the next frame, so repeating the same sentence
  // ("0 assets") is still a change the screen reader will read.
  messages = { ...messages, [politeness]: '' };
  notify();
  requestAnimationFrame(() => {
    messages = { ...messages, [politeness]: text };
    notify();
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function Announcer() {
  const current = useSyncExternalStore(subscribe, () => messages);
  return (
    <>
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-announcer="polite">
        {current.polite}
      </div>
      <div className="visually-hidden" role="alert" aria-live="assertive" aria-atomic="true" data-announcer="assertive">
        {current.assertive}
      </div>
    </>
  );
}
