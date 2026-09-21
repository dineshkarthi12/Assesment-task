import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import { announce } from '@/components/Announcer';
import type { Asset } from '@/lib/types';
import { PAGE_SIZE } from '@/lib/viewQuery';
import type { SelectionStore } from '@/features/selection/selectionStore';
import type { AssetStore } from './assetStore';
import { AssetCard, SkeletonCard } from './AssetCard';

/* Layout constants. Card height is computed, never measured, which is what lets
 * the grid know every row's position without rendering it. */
const MIN_CARD_WIDTH = 220;
const GAP = 12;
const PAD = 16;
const CARD_BODY_HEIGHT = 84;
const CARD_BORDER = 2;
const THUMB_RATIO = 10 / 16;
/** Rows rendered beyond each edge of the viewport, so fast scrolling does not show blanks. */
const OVERSCAN_ROWS = 2;
/** Start fetching the next page while it is still this many rows below the viewport. */
const PREFETCH_ROWS = 6;

interface Layout {
  cols: number;
  thumbHeight: number;
  cardHeight: number;
  rowHeight: number;
}

function computeLayout(width: number): Layout {
  const inner = Math.max(0, width - PAD * 2);
  const cols = Math.max(1, Math.floor((inner + GAP) / (MIN_CARD_WIDTH + GAP)));
  const cardWidth = (inner - GAP * (cols - 1)) / cols;
  const thumbHeight = Math.max(0, Math.round((cardWidth - CARD_BORDER) * THUMB_RATIO));
  const cardHeight = thumbHeight + CARD_BODY_HEIGHT + CARD_BORDER;
  return { cols, thumbHeight, cardHeight, rowHeight: cardHeight + GAP };
}

interface Range {
  first: number;
  last: number;
}

function computeRange(scrollTop: number, height: number, layout: Layout): Range {
  return {
    first: Math.max(0, Math.floor((scrollTop - PAD) / layout.rowHeight) - OVERSCAN_ROWS),
    last: Math.max(0, Math.floor((scrollTop + height - PAD) / layout.rowHeight) + OVERSCAN_ROWS),
  };
}

export interface AssetGridHandle {
  /** Focus this asset's card, or the nearest card if it is no longer in the list. */
  focusAsset(id: string): boolean;
  /** Focus the grid's current card. False if the grid has no cards. */
  focusCurrent(): boolean;
}

interface Props {
  assets: Asset[];
  /** Size of the whole result set, for aria-rowcount. */
  total: number;
  /** Identity of the result set; a new one scrolls back to the top. */
  resultKey: string;
  /** More pages exist and none has failed: reserve space for the next one. */
  hasMore: boolean;
  /** Showing the previous query's rows while a new one loads. */
  stale: boolean;
  activeId: string | null;
  selection: SelectionStore;
  assetStore: AssetStore;
  onOpen: (id: string) => void;
  onCheck: (id: string, extend: boolean) => void;
  onNearEnd: () => void;
  footer: ReactNode;
}

/**
 * Virtualized, keyboard-operable grid (ARIA grid pattern).
 *
 * Virtualization: only rows intersecting the viewport (plus overscan) are in
 * the DOM, so node count depends on window size, not on how far the user has
 * scrolled. Every row has the same computed height, so row `r` sits at a known
 * offset. While more pages exist, one page of skeleton slots is reserved after
 * the loaded rows and filled in place.
 *
 * Keyboard: one tab stop (roving tabindex). Arrows move, Home/End go to the
 * start/end of the row (with Ctrl, of the loaded list), PageUp/PageDown move a
 * screen, Space toggles selection, Shift+movement extends a range from the
 * anchor, Ctrl+A selects everything loaded, Enter opens.
 *
 * Focus and virtualization: the focused card's row is always rendered, even
 * when scrolled out of view, so the element holding focus is never removed.
 */
export const AssetGrid = memo(
  forwardRef<AssetGridHandle, Props>(function AssetGrid(
    {
      assets,
      total,
      resultKey,
      hasMore,
      stale,
      activeId,
      selection,
      assetStore,
      onOpen,
      onCheck,
      onNearEnd,
      footer,
    },
    ref,
  ) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [layout, setLayout] = useState<Layout>(() => computeLayout(0));
    const [range, setRange] = useState<Range>({ first: 0, last: 0 });
    const [focusIndex, setFocusIndex] = useState(0);
    const layoutRef = useRef(layout);
    const pendingScrollTop = useRef<number | null>(null);
    const pendingFocus = useRef(false);
    const assetsRef = useRef(assets);
    const focusIndexRef = useRef(focusIndex);
    const announceTimer = useRef<number | undefined>(undefined);
    useLayoutEffect(() => {
      assetsRef.current = assets;
      focusIndexRef.current = focusIndex;
    });

    // Measure, and re-measure on resize. When the column count changes (the
    // detail panel opening narrows the grid), the same scrollTop would point at
    // different assets, so capture which item was at the top under the old
    // layout and restore it under the new one.
    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (!el) return;

      const apply = (width: number, height: number, sync: boolean) => {
        const prev = layoutRef.current;
        const next = computeLayout(width);
        let top = el.scrollTop;
        if (next.cols !== prev.cols || next.rowHeight !== prev.rowHeight) {
          const offset = Math.max(0, el.scrollTop - PAD);
          const row = Math.floor(offset / prev.rowHeight);
          const withinRow = (offset - row * prev.rowHeight) / prev.rowHeight;
          const anchorIndex = row * prev.cols;
          top =
            el.scrollTop === 0
              ? 0
              : PAD + (Math.floor(anchorIndex / next.cols) + withinRow) * next.rowHeight;
          pendingScrollTop.current = top;
        }
        layoutRef.current = next;
        const update = () => {
          setLayout(next);
          setRange(computeRange(top, height, next));
        };
        // A resize must re-lay out before the browser paints, or the grid
        // visibly jumps for a frame. Inside this layout effect React already
        // commits synchronously; the ResizeObserver callback needs flushSync.
        if (sync) flushSync(update);
        else update();
      };

      apply(el.clientWidth, el.clientHeight, false);
      const observer = new ResizeObserver(([entry]) => {
        if (entry) apply(entry.contentRect.width, entry.contentRect.height, true);
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    // Apply the anchored scroll position once the new layout's height is in the DOM.
    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (el && pendingScrollTop.current !== null) {
        el.scrollTop = pendingScrollTop.current;
        pendingScrollTop.current = null;
      }
    }, [layout]);

    // A new result set starts at the top, with the first card as the tab stop.
    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollTop = 0;
      setRange(computeRange(0, el.clientHeight, layoutRef.current));
      setFocusIndex(0);
    }, [resultKey]);

    // Keep the tab stop on a card that exists. A functional update, because in
    // the commit where a new result set arrives the reset above has already
    // queued 0; clamping this render's (stale) index would overwrite it.
    useEffect(() => {
      if (assets.length) setFocusIndex((i) => Math.min(i, assets.length - 1));
    }, [assets.length]);

    // Move DOM focus once the card for focusIndex has been rendered.
    useLayoutEffect(() => {
      if (!pendingFocus.current) return;
      const card = scrollRef.current?.querySelector<HTMLElement>(`[data-index="${focusIndex}"]`);
      if (card) {
        pendingFocus.current = false;
        card.focus({ preventScroll: true });
      }
    });

    const onScroll = () => {
      const el = scrollRef.current;
      if (!el) return;
      const next = computeRange(el.scrollTop, el.clientHeight, layoutRef.current);
      // Only re-render when the set of rows changes, not on every scroll event.
      setRange((prev) => (prev.first === next.first && prev.last === next.last ? prev : next));
    };

    function scrollIndexIntoView(index: number) {
      const el = scrollRef.current;
      if (!el) return;
      const { cols, rowHeight, cardHeight } = layoutRef.current;
      const top = PAD + Math.floor(index / cols) * rowHeight;
      const bottom = top + cardHeight;
      if (top < el.scrollTop + PAD) el.scrollTop = Math.max(0, top - PAD);
      else if (bottom > el.scrollTop + el.clientHeight - PAD) el.scrollTop = bottom - el.clientHeight + PAD;
      setRange(computeRange(el.scrollTop, el.clientHeight, layoutRef.current));
    }

    function moveFocusTo(index: number) {
      pendingFocus.current = true;
      setFocusIndex(index);
      scrollIndexIntoView(index);
    }

    useImperativeHandle(
      ref,
      () => ({
        focusAsset(id) {
          const list = assetsRef.current;
          if (!list.length) return false;
          const found = list.findIndex((a) => a.id === id);
          moveFocusTo(found >= 0 ? found : Math.min(focusIndexRef.current, list.length - 1));
          return true;
        },
        focusCurrent() {
          const list = assetsRef.current;
          if (!list.length) return false;
          moveFocusTo(Math.min(focusIndexRef.current, list.length - 1));
          return true;
        },
      }),
      [],
    );

    function announceSelectionSoon() {
      window.clearTimeout(announceTimer.current);
      announceTimer.current = window.setTimeout(() => {
        const n = selection.size();
        announce(n === 0 ? 'Selection cleared' : `${n.toLocaleString()} selected`);
      }, 400);
    }

    /** Shift+movement: the selection between the anchor and the focus follows the focus. */
    function extendSelection(from: number, to: number) {
      const anchorId = selection.anchor;
      let anchor = anchorId ? assets.findIndex((a) => a.id === anchorId) : -1;
      if (anchor < 0) {
        anchor = from;
        selection.anchor = assets[from]!.id;
      }
      const span = (a: number, b: number) =>
        assets.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id);
      const next = span(anchor, to);
      const keep = new Set(next);
      selection.setMany(span(anchor, from).filter((id) => !keep.has(id)), false);
      selection.setMany(next, true);
      announceSelectionSoon();
    }

    function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
      const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-index]');
      if (!cell || !assets.length) return;
      const index = Number(cell.dataset.index);
      const { cols } = layoutRef.current;
      const last = assets.length - 1;
      const perPage = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / layoutRef.current.rowHeight));
      const rowStart = index - (index % cols);
      let next: number;

      switch (e.key) {
        case 'ArrowRight': next = Math.min(last, index + 1); break;
        case 'ArrowLeft': next = Math.max(0, index - 1); break;
        case 'ArrowDown': next = Math.min(last, index + cols); break;
        case 'ArrowUp': next = index - cols >= 0 ? index - cols : index; break;
        case 'Home': next = e.ctrlKey || e.metaKey ? 0 : rowStart; break;
        case 'End': next = e.ctrlKey || e.metaKey ? last : Math.min(last, rowStart + cols - 1); break;
        case 'PageDown': next = Math.min(last, index + cols * perPage); break;
        case 'PageUp': next = Math.max(index % cols, index - cols * perPage); break;
        case ' ':
          // A checkbox focused by mouse toggles itself natively; don't toggle twice.
          if ((e.target as HTMLElement).tagName === 'INPUT') return;
          e.preventDefault();
          selection.toggle(assets[index]!.id);
          selection.anchor = assets[index]!.id;
          return;
        case 'Enter':
          e.preventDefault();
          onOpen(assets[index]!.id);
          return;
        case 'a':
        case 'A':
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          selection.setMany(assets.map((a) => a.id), true);
          announceSelectionSoon();
          return;
        default:
          return;
      }

      e.preventDefault();
      if (e.shiftKey) extendSelection(index, next);
      else selection.anchor = assets[next]!.id;
      moveFocusTo(next);
    }

    // Clicking or tabbing onto a card makes it the tab stop. Only the cell
    // itself counts: a mouse click on a checkbox focuses the checkbox, and
    // must not move the tab stop (that would re-render a second card).
    function onFocus(e: FocusEvent<HTMLDivElement>) {
      const target = e.target as HTMLElement;
      if (target.getAttribute('role') === 'gridcell') setFocusIndex(Number(target.dataset.index));
    }

    const { cols, rowHeight, cardHeight, thumbHeight } = layout;
    const slotCount = assets.length + (hasMore ? PAGE_SIZE : 0);
    const totalRows = Math.ceil(slotCount / cols);
    const lastRow = Math.min(range.last, totalRows - 1);

    // Infinite scroll: ask for the next page when it comes within PREFETCH_ROWS
    // of the viewport. loadMore is idempotent, so repeated calls are harmless;
    // when a page lands and the viewport is still short, this fires again.
    useEffect(() => {
      if (hasMore && !stale && (range.last + PREFETCH_ROWS) * cols >= assets.length) onNearEnd();
    }, [hasMore, stale, range.last, cols, assets.length, onNearEnd]);

    const renderRow = (r: number) => (
      <GridRow
        key={r}
        row={r}
        cols={cols}
        top={PAD + r * rowHeight}
        height={cardHeight}
        assets={assets}
        slotCount={slotCount}
        focusIndex={focusIndex}
        activeId={activeId}
        selection={selection}
        assetStore={assetStore}
        onOpen={onOpen}
        onCheck={onCheck}
      />
    );
    const rows: ReactNode[] = [];
    // The focused card's row stays mounted even when scrolled away, so the
    // element that has focus is never removed from the document.
    const focusRow = Math.floor(focusIndex / cols);
    if (focusRow < range.first && focusRow < totalRows) rows.push(renderRow(focusRow));
    for (let r = range.first; r <= lastRow; r++) rows.push(renderRow(r));
    if (focusRow > lastRow && focusRow < totalRows) rows.push(renderRow(focusRow));

    return (
      <div
        ref={scrollRef}
        className={stale ? 'grid-scroll grid-scroll--stale' : 'grid-scroll'}
        onScroll={onScroll}
      >
        {stale && (
          <div className="grid-stale-note" aria-hidden="true">
            <span>Showing previous results — updating…</span>
          </div>
        )}
        <div
          className="grid-canvas"
          role="grid"
          aria-label="Assets"
          aria-multiselectable="true"
          aria-rowcount={Math.ceil(Math.max(total, assets.length) / cols)}
          aria-colcount={cols}
          aria-busy={stale}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          style={{
            height: totalRows > 0 ? PAD * 2 + totalRows * rowHeight - GAP : 0,
            ['--thumb-height' as string]: `${thumbHeight}px`,
            ['--card-body-height' as string]: `${CARD_BODY_HEIGHT}px`,
          }}
        >
          {rows}
        </div>
        {footer}
      </div>
    );
  }),
);

interface RowProps {
  row: number;
  cols: number;
  top: number;
  height: number;
  assets: Asset[];
  slotCount: number;
  focusIndex: number;
  activeId: string | null;
  selection: SelectionStore;
  assetStore: AssetStore;
  onOpen: (id: string) => void;
  onCheck: (id: string, extend: boolean) => void;
}

const GridRow = memo(function GridRow({
  row,
  cols,
  top,
  height,
  assets,
  slotCount,
  focusIndex,
  activeId,
  selection,
  assetStore,
  onOpen,
  onCheck,
}: RowProps) {
  const cells: ReactNode[] = [];
  for (let c = 0; c < cols; c++) {
    const index = row * cols + c;
    const asset = assets[index];
    if (asset) {
      cells.push(
        <AssetCard
          key={asset.id}
          asset={asset}
          index={index}
          column={c + 1}
          tabbable={index === focusIndex}
          active={asset.id === activeId}
          selection={selection}
          assets={assetStore}
          onOpen={onOpen}
          onCheck={onCheck}
        />,
      );
    } else if (index < slotCount) {
      cells.push(<SkeletonCard key={`skeleton-${index}`} />);
    }
  }
  // A row of placeholders has nothing to read; keep it out of the grid's semantics.
  const placeholderOnly = row * cols >= assets.length;
  return (
    <div
      className="grid-row"
      role={placeholderOnly ? undefined : 'row'}
      aria-rowindex={placeholderOnly ? undefined : row + 1}
      aria-hidden={placeholderOnly || undefined}
      style={{
        height,
        transform: `translateY(${top}px)`,
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        left: PAD,
        right: PAD,
        gap: GAP,
      }}
    >
      {cells}
    </div>
  );
});
