import { useNetworkState } from '@/api/network';
import { Icon } from './Icon';

/**
 * Says what is happening to the connection, and what happens to the user's
 * work meanwhile. Not a live region itself: App announces the transitions.
 */
export function NetworkBanner() {
  const { reachable, browserOnline, pausedUntil } = useNetworkState();

  if (!reachable) {
    return (
      <div className="banner banner--offline">
        <Icon name="offline" />
        <p>
          <strong>{browserOnline ? 'Can’t reach MediaVault.' : 'You’re offline.'}</strong>{' '}
          Reconnecting automatically. Changes you make are kept and sent when you’re back —
          reloading the page before then loses them.
        </p>
      </div>
    );
  }
  if (pausedUntil > 0) {
    return (
      <div className="banner">
        <Icon name="pause" />
        <p>MediaVault is busy, so requests are paused for a few seconds. Nothing needs doing.</p>
      </div>
    );
  }
  return null;
}
