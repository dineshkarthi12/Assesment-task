import { statusLabel } from '@/lib/format';
import type { AssetStatus } from '@/lib/types';

/**
 * The four statuses read as a progression through the glyph's *fill*:
 * draft is an empty circle, in review half full, approved full with a check.
 * Archived is a different *shape* — a shelved box — because it leaves the
 * pipeline rather than advancing along it.
 *
 * Shape and the text label carry the status on their own; colour only
 * reinforces it, so it survives red/green colour blindness and greyscale.
 */
export function StatusGlyph({ status, colored = false }: { status: AssetStatus; colored?: boolean }) {
  return (
    <svg
      className={`status-glyph${colored ? ` status-color--${status}` : ''}`}
      viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
      {status === 'archived' ? (
        <>
          <rect x="1.75" y="2.75" width="10.5" height="9.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M1.75 5.75h10.5M5.5 8.25h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="5.25" fill={status === 'approved' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" />
          {status === 'in_review' && <path d="M7 1.75a5.25 5.25 0 0 0 0 10.5z" fill="currentColor" />}
          {status === 'approved' && (
            <path d="M4.5 7.2l1.7 1.7 3.4-3.6" fill="none" stroke="var(--surface)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          )}
        </>
      )}
    </svg>
  );
}

export function StatusBadge({ status, pending = false }: { status: AssetStatus; pending?: boolean }) {
  return (
    <span className={`status status--${status}${pending ? ' status--pending' : ''}`}>
      <StatusGlyph status={status} />
      {statusLabel(status)}
    </span>
  );
}
