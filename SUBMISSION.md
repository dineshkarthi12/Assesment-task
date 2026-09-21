# Submission

## In one screen

MediaVault rebuilt around one idea: on this API, *when* an answer arrives says
nothing about *whether* it is still the answer. Every layer assumes responses
arrive late, out of order, partially, or not at all.

- **Search** is debounced, cancelled and key-guarded, and the query lives in the
  URL. A cursor is never separable from the query that issued it, so
  `400 stale_cursor` is unreachable rather than handled.
- **The grid** is virtualized by hand (uniform rows, so no measurement), pages
  into reserved slots, and restores the user's place when the column count
  changes. Selection lives outside React, so one toggle re-renders one card.
- **Writes** are optimistic against one store keyed by asset id and operation
  id, so a late failure can only roll back its own change. Bulk splits into
  50s, three in flight, and reports per asset what did not change and why —
  with retry offered only where retry can work.
- **Failure** is a first-class value: every error is an `ApiError` with
  `status`, `code` and `retryAfterMs`; retry decisions are structural, never
  string matching; and one shared gate pauses every request during a 429 or an
  outage so the retries do not become the storm.
- **The keyboard** operates the grid as an ARIA grid with a roving tabindex,
  range selection and focus that survives virtualization. One live region
  announces outcomes.

Three numbers, all measured on production builds against the chaos API:

| | Before | After |
| --- | --- | --- |
| DOM nodes at ~4–5,000 rows | 27,721 | 397 |
| Requests while typing a 6-character query | 6 | 1 |
| Trials where a stale search response won | 8 of 8 | 0 of 8 |

Cut deliberately: undo for bulk changes, live updates over SSE, the stats
header, and a screen-reader pass. Reasons are in *Trade-offs and cuts*.

## Video walkthrough

**Link:** <!-- paste the Loom/YouTube link here -->
**Deployed:** <!-- paste Render URL here -->
Note: the mock API rate-limits per IP, and behind the deploy proxy every visitor shares one IP, so two people using the deployed instance at once share the 80-requests-per-10s budget. A 429 there is the API working as documented.

---

## How to run it

```bash
npm install
npm run dev     # mock API on :8787 and the app on http://localhost:5173
```

- Chaos and latency are **on** by default, which is how the app is meant to be
  judged. `CHAOS=0 LATENCY=0 npm run dev` turns them off if you want to compare.
- `npm test` runs 23 unit tests (retry policy, request de-duplication,
  bulk batching and rollback). `npm run typecheck` and `npm run build` are clean.
- Nothing under `server/` was changed; the diff against the starter is `src/`,
  `SUBMISSION.md` and `docs/screenshots/`.
- Worth trying: type fast into search with the network tab open; select 500+
  assets and move them while offline (DevTools → Network → Offline); open the
  detail panel and change the same asset in a second tab to see the 409 path.

## Time spent

About 15 hours over 4 days, roughly: defect inventory 1h, request layer
and search 4h, virtualization 3h, bulk and optimistic writes 3h, retries
and offline 1.5h, accessibility 1h, visual system 1h, write-up 0.5h.

---

## Baseline defects found

| # | Defect | Where | Fixed / left / out of scope |
| --- | --- | --- | --- |
| 1 | Bulk update sends every selected id in one request; fails outright above 50 (`400 too_many_ids`) | `App.tsx` `applyBulkStatus` | **Fixed** (Task 3) — 550 ids went out as 11 calls of exactly 50, at most 3 in flight |
| 2 | Search race: the effect has no cleanup and no abort, so whichever response lands last wins. Measured: typing `tra`→`trail` left wrong rows on screen in **8/8** trials, and in half of them the winner was the one-letter `t` query (slowest of all), e.g. "Night Bus Reframe" shown for "trail" | `useAssets.ts` effect | **Fixed** (Task 1) — 0/8 |
| 3 | Every keystroke fires a request (no debounce), and `StrictMode` double-runs the effect; this burns the 80 req / 10s budget and triggers `429` | `App.tsx` comment, `useAssets.ts` | **Fixed** (Task 1) — 6 requests → 1 for a 6-letter query; 2 → 1 on a StrictMode mount |
| 4 | Pagination is never used: only the first 24 rows load, `nextCursor` is stored but never read, so the header says "24 of 12,400 shown" with no way to see the rest | `useAssets.ts`, `App.tsx` | **Fixed** (Tasks 1–2) — cursor paging, then infinite scroll |
| 5 | Loading, empty and error are conflated: `AssetGrid` shows "Nothing matches these filters" whenever `items` is empty, including during the first load and after a failed request; after an error, the previous page of rows stays visible next to the error line | `AssetGrid.tsx`, `useAssets.ts` | **Fixed** (Task 1) |
| 6 | Query state (q, status, sort) is component state, not in the URL, so reload and sharing lose the view; `kind` and `tag` have no UI at all although the API and `AssetQuery` support them | `App.tsx` | **Fixed** (Task 1) |
| 7 | No virtualization: the grid renders every loaded card, so DOM size grows with scroll depth | `AssetGrid.tsx` | **Fixed** (Task 2) — 27,721 DOM nodes at 3,950 rows → 397 at 5,050 |
| 8 | Toggling one selection re-renders every card: a fresh `Set` per toggle, inline handlers, and no `memo` on the card | `App.tsx` `toggleSelect`, `AssetGrid.tsx` | **Fixed** (Task 2) — 50 of 50 → 1 |
| 9 | Thumbnails: eager `<img>` for every card, `hasThumbnail` ignored, no `onError`; the ~4% missing ones show a broken image | `AssetGrid.tsx`, `AssetDetail.tsx` | **Fixed** (Task 2) — 0 requests for known-missing thumbnails, 0 broken images |
| 10 | Bulk result is lossy: it only reports "N updated, M failed", drops the per-id `results`, and clears the whole selection even on partial failure, so the user cannot see which assets failed, why, or retry them. Nothing is optimistic | `App.tsx` `applyBulkStatus` | **Fixed** (Task 3) |
| 11 | List is not told about single edits: `handleSaved` is an empty function, so the grid shows stale status/version after a detail-panel save | `App.tsx` `handleSaved` | **Fixed** (Task 3) — card and panel read the same asset store |
| 12 | Detail panel: no `409 version_conflict` handling (raw string, stale `version` kept, buttons then keep failing); `getAsset` in the effect has no cancel or cleanup, so opening A then B quickly can show A's data under B | `AssetDetail.tsx` | **Fixed** (Tasks 1 and 3) |
| 13 | HTTP client flattens errors to `"429: message"` strings: callers cannot branch on `code` or status, cannot tell retryable from non-retryable, and users see the leaked string. There is no retry, backoff, `Retry-After` handling, offline detection or de-duplication | `client.ts`, `App.tsx`, `AssetDetail.tsx` | **Fixed** (Tasks 1 and 4) — 5 chaos 503s over 30 loads produced 0 error screens |
| 14 | No error boundary, so a render error blanks the page | `main.tsx` | **Fixed** (Task 4) — separate boundaries for the list, the panel and the app |
| 15 | Grid is not keyboard-accessible: cards are `div onClick` with no role, no tabindex, no key handling; the checkbox has no accessible name; no grid semantics or `aria-selected` | `AssetGrid.tsx` | **Fixed** (Task 5) |
| 16 | Detail panel does not move focus in, restore focus to the opening card, close on Escape, or expose a landmark/dialog role | `AssetDetail.tsx` | **Fixed** (Task 5) |
| 17 | No live region: result counts, bulk outcomes and errors are never announced; the search input and sort select have no label (placeholder only) | `App.tsx` | **Fixed** (Tasks 1 and 5) |

Checked and not a defect: text contrast of the inherited styles. I measured it in Task 6 with the same script as the new design: the lowest ratio was 5.26:1 (`--ink-soft` on `--bg-soft`), which passes AA. Status pills do carry a text label, so they are not colour-only; they were just visually undifferentiated, which Task 6 addresses.

---

## Key decisions

**Data fetching and caching**

No data library, no new dependencies. Hand-rolled because the parts this brief assesses (cancellation, de-duplication, error classification, and later rollback) are what TanStack Query would do for me, and I would rather show and defend them than configure them. The cost is +3.3 kB gzipped over the baseline. All requests go through `src/api/http.ts`:

- Every failure becomes an `ApiError` with `status`, `code`, `requestId` and `retryAfterMs`. Callers branch on those, never on `message`. Cancellation is a `DOMException('AbortError')`, and every catch site checks for it first and does nothing.
- Concurrent GETs for the same URL share one request. Each caller brings its own `AbortSignal`, and the shared request is aborted only when the last caller leaves. That abort is deferred by one microtask, so React StrictMode's mount → unmount → mount rejoins the request instead of firing a second one (measured: 2 → 1 initial requests in dev).
- The URL is canonical: array filters are sorted, and `q` is trimmed and lowercased because the server does the same. That makes the de-dup key stable. It also matters for cursors, which the server binds to the exact query string, so `status=draft,approved` vs `approved,draft` would otherwise be a `stale_cursor`.
- Facets are fetched once and cached for the page's lifetime (API.md: "safe to cache hard"). If they fail, only the tag picker degrades.

**Stale response handling**

Three layers, each enough on its own for the race:

1. **Debounce, 250 ms** (`SearchBox.tsx`). Inter-key gaps in ordinary typing are about 120–200 ms, so a word becomes one request. Four searches a second at most is half the 80-per-10s budget, which leaves room for paging and detail loads. Enter commits immediately. The debounce, not cancellation, is what protects the rate limit: by the time a request is aborted it has usually already reached the server and counted.
2. **Cancellation.** The first-page effect in `useAssetSearch` aborts on cleanup, so a superseded search is cancelled in the network, not just ignored. The test run shows the `tra` request as aborted.
3. **A key guard on every write to state:** `s.requestedKey !== key ? s : …`. This is deliberately redundant with the abort. If a future change breaks cancellation, a stale response still cannot land.

Pagination: a `Results` object holds `nextCursor` together with the exact `query` that produced it. The next page is always requested with that pair, so a cursor can never be sent with a different query, and `400 stale_cursor` is unreachable by construction. A defensive handler still reloads page one silently if the server ever disagrees. Changing any filter aborts an in-flight page request. Because cursors are offsets, a row edited between pages can reappear, so appended pages are de-duplicated by id.

Loading, empty and error are three separate render branches in `App.tsx`. On a new search the previous rows stay visible but are dimmed, marked `aria-busy`, and the count reads "Searching…". I chose this over blanking the grid because the producer in the brief complains about flicker, and nothing on screen claims to answer the new query until the answer arrives. An error never shows old rows underneath it, because old rows under a failed new query would be misleading.

The old rows are shown for **at most 1.5 s** (`STALE_ROWS_MAX_MS`), then replaced by the loading state. I added that limit in Task 4. With retries, a search can now take seconds (`Retry-After: 2` on a 503, or an outage), and old rows should not stand in for an answer that long. 1.5 s is above the API's slowest ordinary response (about 1.2 s for a 1–2 character query), so normal searches still do not flicker. I found the problem by measurement: my Task 1 race harness flagged 1 trial in 8 on the Task 4 build. Forcing a 503 on the newer query showed the cause. The old rows were correctly marked busy, and replaced by the right answer after the retry, but they stayed up for over 2 s. With the limit in place: 12/12 correct, and "Loading assets…" appears at the 1.5 s mark.

**Virtualization approach**

Hand-rolled in `AssetGrid.tsx` (about 250 lines) rather than TanStack Virtual. The grid is uniform: every card's height is computed from the container width, never measured. So row `r` is at a known offset, the total height is known without rendering anything, and the visible range is two divisions. A library's value is in variable-height measurement, which this layout does not need. Only rows that intersect the viewport, plus 2 rows of overscan, are mounted. State is updated only when that set of rows changes, not on every scroll event.

- **Infinite scroll with reserved space.** While more pages exist, one page of skeleton slots is rendered after the loaded rows, and the next page is requested once it is within 6 rows of the viewport. The arriving page fills those exact slots, so nothing moves (cumulative layout shift 0.0000 over a full test run). I rejected sizing the scrollbar to `total` up front: cursors only move forward, so dragging to row 10,000 would mean ~200 sequential requests against a rate limit.
- **Scroll position across layout changes.** Opening the detail panel narrows the grid from 5 columns to 4, so the same `scrollTop` would point at different assets. A `ResizeObserver` records which item was at the top under the old layout and restores it under the new one, inside `flushSync` so there is no one-frame jump. Measured drift: 7 px. The browser's native scroll anchoring handled this imperfectly in the non-virtualized build (274 px drift) and cannot work at all with absolutely positioned rows, so it is turned off (`overflow-anchor: none`) and replaced.
- **Selection** moved out of React state into a small external store (`selectionStore.ts`). Each memoised card subscribes to its own id through `useSyncExternalStore` and reads a boolean. The bulk bar subscribes to the count. No component holds the `Set`, so a toggle changes no card's props.
- **Thumbnails.** No request is made when `hasThumbnail` is false. Images use `loading="lazy"` and `decoding="async"`. A load error swaps in a placeholder occupying the same box. In Task 2 I remembered failed ids so a remounted card would not request them again. Task 4 showed that was wrong. The server only 404s thumbnails for `hasThumbnail: false`, which are never requested, so any other error is the network, and remembering it would blank those thumbnails for the rest of the session after a wifi drop. Now a failed thumbnail says "Preview unavailable" and is requested again once the connection is back.

**Optimistic updates and rollback**

Optimistic state lives in one place: the `pending` map in `assetStore.ts`, keyed by asset id. Each entry records the status being written and the **operation id** that wrote it. What a card or the detail panel shows is resolved in three steps: the list's copy of the asset, then a newer confirmed copy from any write response (compared by `version`), then the pending status on top. Components read this per id through `useSyncExternalStore`, so moving 500 assets re-renders only the cards on screen.

A rollback finds its state by id and removes the entry **only if its op id still matches**. So if a second change to an asset starts while the first is in flight, the first one's late failure cannot undo the second (covered by a unit test). Successes store the server's returned asset, so the new `version` flows into the next edit.

Bulk (`bulkStatus.ts`): ids are split into batches of 50, with 3 batches in flight (`mapWithConcurrency`). Three because 500 assets is 10 batches, and three at a time finishes in about four round trips while using at most 3 of the 80-per-10s budget at once. Each item in a `207` is confirmed or rolled back on its own. A whole batch that fails (network, `503`) rolls back only its 50 ids. The function never throws: every id ends in exactly one of `succeeded` or `failed`.

The two failure reasons get different treatment because one of them will never succeed:

- `conflict` (random, about 7%) is marked **retryable**. "Retry N" re-sends exactly those ids (measured: offered 35, sent 35).
- `legal_hold` and `not_found` are properties of the asset. They are listed with the reason and what the user *can* do, and never offered for retry (measured: a legal-hold-only selection shows no Retry button).

The report names every asset that did not change, grouped by reason (first six per group, the rest behind "Show all"), and each affected card is marked "Not changed: …" in place. Selection is cleared when the operation starts; the report and the card marks carry the result from then on.

**409 in the detail panel.** On `409` I re-fetch the asset and compare its status with the status the user was looking at:

- **Unchanged** means the concurrent edit touched something else (name, tags). The user's status change does not overlap it, so it is re-applied once on the latest version, silently. Measured: `PATCH` 409 → 200, and the server kept both the new status and the other person's tags.
- **Changed** means two people made the same review decision differently. I neither overwrite theirs (last-write-wins would silently undo a colleague's approval) nor drop mine without saying so. The panel shows their value and says so: "While you were looking, someone else moved this asset to Draft. Your change to Approved wasn't saved." It offers "Move to Approved anyway" and "Keep Draft".

I rejected always-retry because it is last-write-wins with extra steps, and always-refuse because it would interrupt the user for edits that do not conflict with theirs.

**Retry and backoff policy**

All in `http.ts` and `network.ts`. Every request, reads and writes, goes through `sendWithRetry`:

- **What is retried** is decided structurally by `isRetryable(ApiError)`: no response (status 0), 408, 429 and 5xx. 400, 404, 409 and 422 go back to the caller on the first attempt. The decision never looks at a message. There are **at most 4 attempts** (one try plus three retries), because every retry counts against the 80-per-10s budget.
- **Delay.** `Retry-After` wins when present (503 → 2 s, 429 → 3 s), plus up to 250 ms of jitter. Otherwise it is exponential with *equal* jitter: half to all of 500 ms, 1 s, 2 s…, capped at 8 s. I chose equal over full jitter so a retry is never fired almost immediately.
- **One gate for the whole client.** Before every attempt, a request waits in `waitUntilClear` while the connection is down or a 429 pause is in force. The rate limit is per client and counts retries, so a 429 has to pause *everyone*. If each request handled its own 429, the retries would become the storm. Waiting at the gate costs no attempts. Measured: with the budget exhausted from outside, the app's search got one 429 and the banner showed. The user kept typing, so the pending retry of the old query was cancelled, and exactly one request (for the newest query) went out when the pause ended. Results appeared at 3.6 s with no error screen.
- **Writes are retried too, and that is safe for this API.** PATCH carries `version`, so a replay of a write that did land returns 409. The panel treats "409, and the asset already has the status I asked for" as success, rather than telling the user someone else made their own change. Bulk-status *sets* a value, so it is idempotent. Unit tests cover waiting out Retry-After, never retrying 400/404/409/422, retrying PATCH 500, giving up after 4 attempts, and a 429 holding a second, unrelated request.
- **Measured under chaos:** 30 fresh list loads saw 5 × 503 (8.5%) and showed 0 error screens.

**Offline**

The connection is treated as down when the browser fires `offline`, **or** when any request fails without a response. The second case matters because office wifi can drop while `navigator.onLine` stays true. While down, the gate holds every request, and recovery is detected by polling `/api/health` (never rate limited) at 1 s, 2 s, then every 4 s. The poll also runs at once on the browser's `online` event. A banner says which case it is ("You're offline" or "Can't reach MediaVault") and what happens to the user's work. When the connection returns, a list or page that had failed retries itself. Measured:

- **Browser offline for 20 s**, with a search typed and 4 assets moved to Approved while offline: **0 requests** sent in those 20 s. The cards showed "Approved (saving)" and the list said "Waiting for the connection to load these results…". On reconnect, one health check, then the bulk change and the search went out; results appeared in 234 ms, and the server had all 4 assets approved.
- **Requests failing while the browser still reports online:** 1 request (the one that discovered it), then only health checks. Results appeared 3.6 s after the connection came back, with no click. That was 5.9 s before I lowered the poll cap from 8 s to 4 s.

Writes made offline are effectively queued: they wait at the gate and send on reconnect. That queue is **in memory only**. Reloading while offline loses it, and the banner says so. Persisting it (IndexedDB, replayed on load) is the next step, but replaying a write hours later needs its own conflict policy, so I stopped here.

**Error boundaries**

There are three boundaries. The list's is reset by a new query *or* new results. The panel's is reset by opening another asset, and its fallback offers "Close panel". A last one in `main.tsx` offers Reload, which keeps the view because it lives in the URL. I tested them with malformed server data: an asset with no `owner` crashes only the panel, and the grid's 24 cards stay. A row with an unparseable date crashes only the list, and search and filters stay usable. The test found a bug in my first version. Resetting on the new query alone crashed again straight away, because the previous (broken) rows are still displayed while the new search loads, and it then never reset when the good results arrived. The reset key now includes the results' key, and changing the search recovers the list.

**State placement and URL sync**

The URL is the only store for `q`, `status`, `kind`, `tag` and `sort`. There is no mirrored React state to drift out of sync. `useViewQuery` reads `location.search` through `useSyncExternalStore`, and writes go straight to `history`. Typing uses `replaceState` and discrete filter or sort changes use `pushState`, so Back undoes the last decision rather than the last keystroke (measured: filter + typing "trail" adds one entry, and Back restores the empty view with the box cleared). The URL is treated as untrusted input: unknown statuses, kinds and sorts are dropped on parse, because an unknown sort is a hard `400` and a user should never see that for following an old link. Defaults are omitted, so an unfiltered view has a clean URL. No router: one route did not justify a dependency.

---

## Performance

| Metric | Before | After | How measured |
| --- | --- | --- | --- |
| Rendered DOM nodes at 5,000 rows loaded | 27,721 at **3,950** rows (the run hit its 3-minute cap before 5,000) | 397 at 5,050 rows (253 at the first page) | `document.getElementsByTagName('*').length`. "Before" is my Task 1 commit: same data layer, not yet virtualized. The original code cannot load past 24 rows at all, so it cannot be measured here |
| Cards re-rendered when toggling one selection | 50 of 50 | 1 | Stub of React's DevTools global hook (the one the Profiler uses), counting card elements whose props object changed in a commit. Same method on both production builds. Cross-checked in dev with `window.__renders` (`useRenderCount.ts`): 1, 1, 1 over three toggles. Re-measured after Task 5's roving tabindex: still 1 for a mouse click on a checkbox and for Space on the focused card. Moving focus with an arrow key re-renders 2 cards (the old and new tab stop), which is inherent |
| Longest task during sustained scroll | 15 long tasks, longest 74 ms; frame gap p50 50 ms, p99 130 ms | No long tasks ≥ 50 ms; frame gap p50 10 ms, p99 10.2 ms, worst 20 ms | 6 s of mouse-wheel scrolling top ↔ bottom with all rows loaded. `PerformanceObserver('longtask')` plus `requestAnimationFrame` deltas |
| Scroll drift when the detail panel opens (5 → 4 columns) | 274 px | 7 px | Offset of the top-left card relative to the grid before and after opening the panel, at 20,000 px deep |
| Select all 550 loaded, then move them to In review | n/a (no select-all) | 41–58 ms click-to-bar round trip; no long tasks ≥ 50 ms across select-all and the optimistic update | Playwright timing plus `PerformanceObserver('longtask')`, with bulk responses held back to observe the optimistic state |
| Thumbnail requests that 404 | 2 (plus 2 broken images) | 0 (12 placeholders, no requests) | Response log over ~10 screens of scrolling |
| Requests fired while typing a 6-character query | 6 | 1 | Playwright driving Edge headless, typing `runner` at 120 ms/key into the production build (`vite preview`), chaos and latency on, counting `/api/assets?` requests |
| Stale rows after the `tra`→`trail` race | 8 of 8 trials | 0 of 8 | Same harness: type `tra`, wait 320 ms, type `il`, wait for the list to settle, count visible cards without "trail" in the name |
| Production bundle, gzipped | 48.30 kB JS + 1.17 kB CSS | 51.63 kB JS + 1.49 kB CSS after Task 1; 53.08 kB JS + 1.64 kB CSS after Task 2; 55.76 kB JS + 1.84 kB CSS after Task 3; 57.24 kB JS + 1.86 kB CSS after Task 4; 59.30 kB JS after Task 5; **60.47 kB JS + 3.22 kB CSS after Task 6 (final)**. The +12 kB over baseline is the whole client: request layer, virtual grid, stores, keyboard model and states. There are no runtime dependencies beyond React | `vite build` output. Baseline built from an untouched worktree of the first commit |

All numbers: Intel i5-13420H, 15.7 GB RAM, Windows 11, Edge 153 headless at 1400×900, driven by Playwright. Production builds (`vite preview`) against the mock API with chaos and latency on. Headless frame timing is not identical to a visible window, but both builds were measured the same way.

What was the actual bottleneck, and how did you find it?

DOM size, not React. The first run of the non-virtualized build could not even reach 5,000 rows inside three minutes: each page took about 2.3 s to append and lay out (79 pages in 181 s), against about 0.4 s per page once virtualized (101 pages in 40 s). The per-page cost grew with the number of cards already on the page, which points at layout and style over the whole grid rather than at the network. The render count told a separate story: every selection toggle re-rendered all 50 cards on screen. Fixing that alone would not have fixed scrolling, and virtualizing alone would not have fixed the toggle, so both changes were needed.

---

## Accessibility

**Keyboard model.** The grid is an ARIA `grid` (`aria-multiselectable`, `aria-rowcount` for the *whole* result set so "row 20 of 2480" is true under virtualization). Rows are `row`s, and each card is a `gridcell` with `aria-selected` and one concise label: name, status, kind, size, date. The whole grid is one Tab stop (roving tabindex). Keys:

- Arrows move between cards; Up and Down move a row.
- Home and End go to the start or end of the row; with Ctrl, to the first or last loaded card.
- PageUp and PageDown move a screen.
- Space toggles selection.
- Shift with any movement key extends the selection from the anchor, and shrinks it when you move back.
- Ctrl+A selects everything loaded.
- Enter opens the detail panel.

Opening the panel moves focus into it; its accessible name is "Asset detail" plus the asset name. It is not modal, so there is no trap. Escape (from anywhere, except a search box that still has text) closes it and returns focus to the card that was open. If that card has been filtered out meanwhile, focus goes to the first card of the new results. A "Skip to results" link is the first Tab stop, so the grid is 2 keypresses from page load instead of 11.

Two focus problems are specific to virtualization and are handled explicitly:

- **The focused row is always rendered.** The focused card's row stays mounted even when scrolled out of view, so the element holding focus is never removed. Scroll away with the mouse, press an arrow key, and navigation continues from the focused card and scrolls it back into view.
- **A safety net for detached focus.** If a focused element inside the results is ever detached (the grid replaced by a loading or error state), a `focusout` listener moves focus to the current card or to a "Results" heading instead of letting it fall to `<body>`.

**Announcements.** There is one pair of live regions for the whole app, always in the DOM. Components call `announce()` instead of carrying their own `role="status"`, because regions inserted with text already in them are announced unreliably, and several regions talk over each other. What is announced is outcomes, not progress:

- a finished search's count, once (typing "trail" over 5 keystrokes produced one announcement: "159 assets matching 'trail'")
- a range or select-all ("3 selected", debounced)
- bulk start and result ("Moving 3 assets to In review…", then "Moved 3 assets to In review.")
- errors and loss of connection (assertive)
- the connection coming back

Thumbnails are `alt=""`, and the missing-thumbnail placeholder is `aria-hidden`. The panel's status buttons use `aria-pressed` to expose the current status. Motion is limited to one opacity fade, which is removed under `prefers-reduced-motion`.

**How I tested it.** Everything below was driven with the keyboard in headless Edge (Playwright) against the chaos API, with results checked from the DOM and the accessibility tree:

- one element with `tabindex=0` in the grid, and Tab leaves the grid
- the key sequence Right, Right, Down, Left, Up, End, Home giving 1, 2, 7, 6, 1, 4, 0 at 5 columns
- Shift+Right ×3 then Shift+Left giving 0–3, then 0–2
- Enter and Escape returning focus to the same card
- ArrowDown ×40 keeping the card in view with 45 cells in the DOM
- focus surviving a mouse scroll
- the filtered-out case
- the exact live-region text
- `ariaSnapshot()` of the grid, showing grid → row → gridcell with names, 0 named thumbnails and 0 unnamed checkboxes
- a 3 px focus outline on the focused card

**I did not run a screen reader** (NVDA, JAWS or VoiceOver). So I have verified what the browser *exposes* (roles, names, states, live-region text), not how a screen reader *speaks* it, including verbosity, whether it switches into focus mode on the grid, and how it times announcements.

That testing found one real bug. After a filter change, the tab stop landed on the last card of page one instead of the first card. A passive effect that clamps the index used the stale index from its render and overwrote the reset to 0 from the new result set. It now uses a functional update.

**Known gaps.**

- No screen-reader pass, as above.
- The checkbox inside each card is kept for mouse users and has a name, but in browse mode it duplicates the cell's `aria-selected`.
- Shrinking a Shift range deselects anything in the shrunk-away span, even items selected before the range began.
- The filter groups are plain checkboxes, one Tab stop each; the skip link is the mitigation.
- The bulk report's "Show all" names are not announced when expanded.

---

## Interface decisions

I optimised for someone scanning hundreds of cards a day, whose two questions at a glance are "what state is this in?" and "is this one of mine?". So the chrome is quiet and neutral, and colour is spent on exactly two things, status and selection, with neither carried by colour alone. Everything else is restraint: one type family, five sizes, two weights, a 4 px spacing grid, one accent, and no motion beyond a thumbnail fade that `prefers-reduced-motion` removes. Each state leads with what the user can do next rather than what went wrong.

- **Visual system.** All in the `:root` tokens at the top of `src/styles.css`. Colours are named by job, not hue (`--ink`, `--ink-muted`, `--surface-sunken`, `--accent`, `--danger` / `--success` / `--caution`, each with a `-soft` background), plus a `--status-*` pair per status. There is a 4 px spacing scale (`--space-1` to `--space-12`) and a type scale (`--text-xs` to `--text-xl`). The one accent means "you did this": focus, selection and primary actions. Card geometry is owned by `AssetGrid` and passed in as CSS variables, because the virtual grid computes positions rather than measuring them.
- **Status treatment.** `StatusBadge.tsx`: each status has a glyph whose fill is the progression. Draft is an empty circle, In review is half-filled, and Approved is filled with a check. Archived is a different *shape* (a shelved box, dashed outline) because it leaves the pipeline rather than advancing. Colour reinforces the order (neutral → amber → green → muted) but the shape and the text label carry it on their own, so it survives red-green colour blindness and greyscale. The same glyphs appear in the status filters, the bulk "Move to" buttons and the panel's status picker, so the vocabulary is learned once.
- **Card hierarchy.** Name (14 px, semibold) → meta (12 px, muted) → status badge. The three card states differ in more than colour:
  - *selected*: accent border, tinted body and a ticked checkbox
  - *open in the panel*: ink border and an "Open" tag
  - *keyboard focus*: a 3 px outline outside the card

  A failed write adds a "⚠ Not changed: legal hold" line; a pending one shows a dashed badge and "Saving…".
- **States.**
  - Loading keeps the grid's shape with skeleton cards.
  - Empty (search icon) and error (alert icon) each give one sentence and one primary action: Clear filters or Try again.
  - Offline and "busy" (429) are banners that say what happens to the user's work.
  - A partial bulk failure is an amber report: the summary, "They're back to their previous status. Here's why:", then groups by reason with three names each and the rest behind "Show all". Retry is primary, and only for what retry can fix.
  - The bulk bar is the one accent-tinted strip, shown only with a selection.
  - The stale-results state originally faded the whole grid to 50%, which failed AA. Now only thumbnails fade, and a pinned label says "Showing previous results — updating…".
- **Narrow windows.** Below 720 px the filters fold behind a "Filters · N active" toggle (`aria-expanded`). The detail panel becomes a sheet over the lower 75% of the results instead of taking their space, so the grid keeps its columns and scroll position underneath and the controls are never covered. Measured at 320, 375, 600, 720 and 1024 px wide: no horizontal scroll, 0 overlapping regions, 0 controls off screen, 74–159 px of grid visible above an open sheet, and Close always in view. The first narrow version failed this: the panel took the remaining space and the grid collapsed to zero height.
- **Contrast.** Measured, not estimated. A script (`contrast-lib.js`, run with Playwright in Edge) walks every visible element that holds text in 12 states. The states covered are the grid, selection with the panel open, the skip link, a running bulk change, a partial failure, a successful bulk change, empty, error, the 429 banner, offline, a panel error, and stale results. For each element it resolves the real foreground and background (compositing translucent layers and ancestor opacity) and computes the WCAG 2.x ratio against 4.5:1, or 3:1 for large text. The result was 635 text checks, 17 distinct colour pairs, **0 below AA**, and the lowest is 6.25:1 (`#5a616c` on white, the Archived label). It caught two real failures that I fixed: the faded stale grid, and placeholder text inside a faded thumbnail (1.71:1). For honesty: the original stylesheet also passed AA for text (lowest 5.26:1, same script). Its problem was undifferentiated status, not contrast.
- **Copy.** No status code, error code or server message reaches the screen. Every message is written for the person reading it (`errorCopy.ts`, `bulkStatus.ts`, `NetworkBanner.tsx`). For example:
  - `429: Too many requests in the last 10 seconds` → "MediaVault is busy. It's still busy after a few automatic retries. Wait a moment, then try again." (It is only ever seen after the retries have given up.)
  - `legal_hold` → "Bulk changes are refused for assets on legal hold. Open one to change it on its own — it can never be archived." (It says what the user *can* do.)
  - `conflict` → "Changed by someone else at the same moment — Nothing was overwritten. Retrying is safe."
  - The baseline's "N updated, M failed." became a sentence that names the target status, and a list of which assets did not change and why.

Screenshots: [grid with selection and panel](docs/screenshots/grid.png) · [partial bulk failure](docs/screenshots/bulk-partial.png) · [375 px with the panel as a sheet](docs/screenshots/narrow.png) · [offline](docs/screenshots/state-offline.png) · [error](docs/screenshots/state-error.png) · [empty](docs/screenshots/state-empty.png)

---

## Trade-offs and cuts

- **No live updates and no stats header.** Both optional, both skipped on
  purpose. `/api/events` is the interesting one: the store already resolves a
  server copy over a list copy by `version`, so an `asset.updated` frame would
  slot straight in. What I did not want to ship untested is the interaction
  with optimistic state (a frame arriving mid-write must not undo a pending
  change) and with the virtual grid (a row changing status under a filter it no
  longer matches). `/api/stats` costs a 1.1 s request for a number the header
  already implies from `total`.
- **No undo for bulk changes.** The brief asks for retry *or* undo; I built retry, which targets exactly the recoverable failures. Undo needs each asset's previous status grouped into one bulk call per status, and it can partially fail too. That is worth doing next, because a reviewer who moves 500 assets to the wrong status has no one-click way back today.
- **Optimistic changes do not remove rows from a filtered view.** Move 50 "Draft" assets to "Approved" while filtering on Draft and they stay on screen, showing Approved, until the next search. Removing them would shift every card below while the user is still looking at the result.
- **Selection is cleared when the search or filters change,** so a bulk action cannot hit assets that are no longer on screen.
- **Shift-click extends from the last card clicked** (Gmail-style) and applies that card's state to the whole range. There is no shrink-the-range behaviour.

## Critique of the API

- **Legal hold means two different things.** API.md says legal-hold assets "cannot be moved to `archived`", and single `PATCH` enforces exactly that. Bulk refuses *every* status change for them. So a legal-hold asset can be approved from the detail panel but never in bulk. The client has to explain that difference to users ("Open one to change it on its own"), which it should not need to know.
- **Bulk takes no `version`.** Single edits get optimistic concurrency; bulk is last-write-wins. A reviewer's bulk "Approve" can silently overwrite a colleague's "Archive" from a second earlier. I would accept an optional `{ id, version }` per item and return `version_conflict` per item, the same way `legal_hold` is reported now.
- **Bulk `conflict` is a random failure with a misleading name.** Nothing actually conflicted, and nothing tells the client whether it is safe to retry. Every error should carry an explicit `retryable` flag rather than leaving the client to infer it from codes.
- **Cursors are offsets, and they are forward-only.** Rows edited between pages can repeat or be skipped, so the client de-duplicates by id. There is also no way to jump to row 10,000, which rules out a scrollbar sized to `total`.

## Anything you would like us to look at

- **Tests** (`npm test`, 23 tests) target the concurrency, retry and rollback logic only.
  - `bulkStatus.test.ts` covers batch size and the concurrency cap, optimistic-then-partial-rollback, one failed batch rolling back only its own ids, 4xx never being offered for retry, and an earlier operation's failure not undoing a later change.
  - `http.test.ts` covers de-duplication, a shared request staying alive while any caller wants it, real cancellation when all callers leave, and the StrictMode rejoin. It also covers the retry policy under fake timers: waiting out Retry-After, no retry for 400/404/409/422, retrying PATCH 500, the 4-attempt cap, one 429 holding an unrelated request, and sending nothing while unreachable until a health check passes.
- **Something I got wrong and corrected:** in Task 2 I remembered failed thumbnails, which Task 4's offline work showed would blank them after a wifi drop (see Virtualization approach).
