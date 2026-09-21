/**
 * The handful of icons the states need — one per kind of message, so a state
 * is recognisable before it is read. Decorative: the text beside each says
 * the same thing.
 */
const PATHS = {
  check: 'M5 10.5l3.2 3.2L15 6.8',
  alert: 'M10 3.5l7 12.5H3zM10 8.5v3.5M10 14.2v.1',
  offline: 'M3 7.5a11 11 0 0 1 14 0M5.5 10.3a7 7 0 0 1 9 0M8 13a3 3 0 0 1 4 0M10 15.8v.1M3.5 3.5l13 13',
  search: 'M8.8 14.2a5.4 5.4 0 1 0 0-10.8 5.4 5.4 0 0 0 0 10.8zM12.8 12.8l3.7 3.7',
  pause: 'M7.5 5v10M12.5 5v10',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
