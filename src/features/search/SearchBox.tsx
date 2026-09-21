import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/Icon';

/**
 * 250ms: inter-key gaps in ordinary typing are ~120–200ms, so a word coalesces
 * into one request; and at most 4 searches a second is half the API's
 * 80-per-10s budget, leaving room for paging and detail loads. It also matters
 * that the debounce, not cancellation, is what protects that budget — an
 * aborted request has usually already reached the server and still counts.
 */
export const SEARCH_DEBOUNCE_MS = 250;

interface Props {
  /** The committed query, from the URL. */
  value: string;
  onCommit: (q: string) => void;
}

export function SearchBox({ value, onCommit }: Props) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);

  // The URL changed from outside (Back, "Clear filters"): adopt it.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    if (draft === committed.current) return;
    const timer = window.setTimeout(() => {
      committed.current = draft;
      onCommit(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [draft, onCommit]);

  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        // Enter commits immediately rather than waiting out the debounce.
        e.preventDefault();
        if (draft !== committed.current) {
          committed.current = draft;
          onCommit(draft);
        }
      }}
    >
      <label className="visually-hidden" htmlFor="asset-search">
        Search assets by name or tag
      </label>
      <Icon name="search" />
      <input
        id="asset-search"
        className="search__input"
        type="search"
        placeholder="Search by name or tag"
        autoComplete="off"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    </form>
  );
}
