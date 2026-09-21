import { useState } from 'react';
import { StatusGlyph } from '@/components/StatusBadge';
import { statusLabel } from '@/lib/format';
import type { AssetKind, AssetStatus } from '@/lib/types';
import type { HistoryMode } from '@/lib/useViewQuery';
import {
  EMPTY_VIEW,
  KINDS,
  SORTS,
  STATUSES,
  hasFilters,
  type SortValue,
  type ViewQuery,
} from '@/lib/viewQuery';
import { useFacets } from '@/features/assets/useFacets';

interface Props {
  view: ViewQuery;
  updateView: (change: (prev: ViewQuery) => ViewQuery, mode: HistoryMode) => void;
}

const KIND_LABELS: Record<AssetKind, string> = {
  image: 'Images',
  video: 'Videos',
  document: 'Documents',
};

function toggle<T>(list: readonly T[], value: T, on: boolean, order: readonly T[]): T[] {
  const next = new Set(list);
  if (on) next.add(value);
  else next.delete(value);
  return order.filter((v) => next.has(v));
}

/** Every change here is a discrete decision, so each one is a history entry. */
export function FilterBar({ view, updateView }: Props) {
  const facets = useFacets();
  // Narrow windows only: the bar folds behind a toggle (CSS hides the toggle when wide).
  const [open, setOpen] = useState(false);
  const active = view.status.length + view.kind.length + view.tag.length;
  const availableTags = facets?.tags.filter((t) => !view.tag.includes(t)) ?? [];

  const setStatus = (s: AssetStatus, on: boolean) =>
    updateView((prev) => ({ ...prev, status: toggle(prev.status, s, on, STATUSES) }), 'push');
  const setKind = (k: AssetKind, on: boolean) =>
    updateView((prev) => ({ ...prev, kind: toggle(prev.kind, k, on, KINDS) }), 'push');
  const addTag = (tag: string) =>
    updateView((prev) => ({ ...prev, tag: [...new Set([...prev.tag, tag])].sort() }), 'push');
  const removeTag = (tag: string) =>
    updateView((prev) => ({ ...prev, tag: prev.tag.filter((t) => t !== tag) }), 'push');

  return (
    <>
      <button
        type="button"
        className="button filters-toggle"
        aria-expanded={open}
        aria-controls="filters"
        onClick={() => setOpen((o) => !o)}
      >
        Filters{active > 0 ? ` · ${active} active` : ''}
      </button>
      <div id="filters" className={open ? 'filters filters--open' : 'filters'}>
        <fieldset className="filters__group">
          <legend>Status</legend>
          {STATUSES.map((s) => (
            <label key={s} className="filters__option">
              <input
                type="checkbox"
                checked={view.status.includes(s)}
                onChange={(e) => setStatus(s, e.target.checked)}
              />
              <StatusGlyph status={s} colored />
              {statusLabel(s)}
            </label>
          ))}
        </fieldset>

        <fieldset className="filters__group">
          <legend>Type</legend>
          {KINDS.map((k) => (
            <label key={k} className="filters__option">
              <input
                type="checkbox"
                checked={view.kind.includes(k)}
                onChange={(e) => setKind(k, e.target.checked)}
              />
              {KIND_LABELS[k]}
            </label>
          ))}
        </fieldset>

        <div className="filters__group">
          <label className="filters__option">
            <span className="visually-hidden">Add a tag filter</span>
            <select
              value=""
              disabled={!facets}
              onChange={(e) => {
                if (e.target.value) addTag(e.target.value);
              }}
            >
              <option value="">{facets ? 'Add tag…' : 'Tags unavailable'}</option>
              {availableTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          {view.tag.length > 0 && (
            <ul className="chips" aria-label="Tag filters (all must match)">
              {view.tag.map((t) => (
                <li key={t} className="chip">
                  {t}
                  <button
                    type="button"
                    className="chip__remove"
                    aria-label={`Remove tag ${t}`}
                    onClick={() => removeTag(t)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="filters__option filters__sort">
          Sort
          <select
            value={view.sort}
            onChange={(e) =>
              updateView((prev) => ({ ...prev, sort: e.target.value as SortValue }), 'push')
            }
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {hasFilters(view) && (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => updateView((prev) => ({ ...EMPTY_VIEW, sort: prev.sort }), 'push')}
          >
            Clear filters
          </button>
        )}
      </div>
    </>
  );
}
