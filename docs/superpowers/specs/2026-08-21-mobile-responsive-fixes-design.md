# Mobile responsive fixes — design

## Problem

The site was built without much attention to narrow viewports. Visiting on a
phone shows a cluttered header and at least one component that doesn't work
at all. Per the project owner's priority, this pass fixes functionality
first; visual polish beyond "usable and not broken" is explicitly deferred.

## Audit findings

Code review (not a live device pass — see "Verification" below) of the
in-scope surfaces found four concrete breakages:

1. **Header nav overcrowds on phones** ([Header.tsx](../../../frontend/src/components/Header.tsx),
   [header.css](../../../frontend/src/header.css)) — wordmark + "Today's
   puzzle" + calendar icon + shuffle icon + "Leaderboard" + "Activity" all sit
   in one row. The existing 640px breakpoint only shrinks font-size/padding;
   it never collapses the text labels to icon-only, even though
   [DESIGN.md](../../../DESIGN.md) already specifies that it should.
2. **AI-assist / guess-sequence panel breaks the game page**
   ([App.css](../../../frontend/src/App.css), `.puzzle-page--panel-open`;
   [PuzzlePage.tsx](../../../frontend/src/pages/PuzzlePage.tsx)) — opening it
   forces a side-by-side row layout, scales the board into a hard-coded
   500px canvas, and clips the page to `calc(100vh - 4rem)` with
   `overflow: hidden`. There is no mobile override at all.
3. **Leaderboard table has no small-screen handling**
   ([benchmark.css](../../../frontend/src/benchmark.css), `.bench-table`;
   [StrategyTable.tsx](../../../frontend/src/components/benchmark/StrategyTable.tsx))
   — plain `<table>`, no scroll wrapper, no column-dropping. (The metric
   selector already collapses to a dropdown on mobile — that part is fine.)
4. **Calendar popover** ([header.css](../../../frontend/src/header.css),
   `.calendar-popover`) — fixed at 18.5rem (296px) width, anchored
   `right: 0` under the icon. Likely fine at 375px+ but unverified at the
   narrowest supported width (iPhone SE, 320px).

Board/Tile grid, GameOverModal, and MistakeTracker already use flexible
units (`aspect-ratio`, `fr`, `max-width` + `100%`) and are not touched by
this pass.

## Goals

- Every core interactive component (nav, game board + AI-assist panel,
  leaderboard) is usable and not visually broken at phone widths.
- Lock in that behavior with functional Playwright tests so future changes
  can't silently regress it.
- Minimal diff: reuse the existing 640px breakpoint convention already
  established in `header.css` / `benchmark.css`. No new breakpoint system,
  no CSS framework.

## Non-goals (explicitly deferred)

- DESIGN.md's full mobile visual spec: the leaderboard's 2-line card
  collapse, the calendar's cell-degradation order (drop day number before
  guess count), hero title/description shrink-and-rewrap tuning. These
  require component rewrites and visual iteration beyond "make it work,"
  and are tracked for a later presentation-focused pass.
- Playwright visual-regression / screenshot-diffing. Only functional
  interaction tests are added now — no baseline images, no pixel diffing.
- Any change to the benchmark drill-down pages (strategy detail, puzzle
  runs, activity feed) beyond not being broken — these are internal
  analysis tooling, not phone-first surfaces.

## Design

### 1. Header nav

Below 640px, `.site-header__link` hides its `<span>` text label (the icon
stays) so "Today's puzzle," "Leaderboard," and "Activity" render icon-only,
matching the calendar/shuffle icon buttons. Each link gets an explicit
`aria-label` (currently the accessible name comes from the visible text) so
screen readers still announce something meaningful once the text is hidden.
The wordmark and desktop (>640px) layout are untouched.

### 2. AI-assist / guess-sequence panel

Below 640px, `.puzzle-page--panel-open` drops its `flex-direction: row`,
the fixed `width: 500px` / `transform: scale(0.8)` board sizing, and the
`height: calc(100vh - 4rem); overflow: hidden` page clipping. Instead the
panel stacks full-width below the board in normal document flow (the page
scrolls normally), and the board renders at its regular unscaled size.
Above 640px, current desktop side-by-side behavior is unchanged.

### 3. Leaderboard table

Wrap the `.bench-table` markup in a new container (e.g.
`.bench-table-wrap`) with `overflow-x: auto`, so a too-wide table scrolls
horizontally inside its own box instead of blowing out the page or forcing
unreadably small text. This is a CSS-only, non-breaking change — no changes
to `StrategyTable.tsx`'s markup or data.

### 4. Calendar popover

Add a mobile rule capping `.calendar-popover` width to
`min(18.5rem, calc(100vw - 1rem))` so it can't render past the viewport
edge on narrow phones, while keeping its current 296px width on wider
screens.

### 5. Playwright functional tests

New `frontend/e2e/` directory, `playwright.config.ts` at the frontend root,
`@playwright/test` as a devDependency, and a new `npm run test:e2e` script.
Playwright's `webServer` config runs `vite preview` against a production
build so tests hit real built output, not the dev server.

Tests intercept the same API endpoints the existing Vitest suite already
mocks (`page.route()` against `${VITE_API_URL}/...`), returning fixture
JSON, so no live backend, database, or CI service containers are needed —
this mirrors how [PuzzlePage.test.tsx](../../../frontend/src/pages/__tests__/PuzzlePage.test.tsx)
mocks `fetch` today, just at the network layer instead of the module layer.

Tests run at fixed viewport widths rather than named device presets, since
what's being verified is the breakpoint behavior itself: 375px (iPhone SE),
~390px (a modern phone), 768px (tablet), and one desktop width (e.g. 1280px)
per test to confirm no regression. One test per fix:

- **Header**: at 375px, nav items render icon-only (no visible text label
  in the accessible tree / DOM); clicking a nav icon still navigates
  correctly. At 1280px, text labels are visible as today.
- **AI-assist panel**: at 375px, opening the panel places it below the
  board (not side-by-side); the board stays interactive (a tile click still
  toggles selection). At 1280px, the panel opens side-by-side as today.
- **Leaderboard table**: at 375px, the table's scroll container is present
  and horizontally scrollable, and a row click still navigates to the
  strategy detail page. At 1280px, no scroll container behavior change.
- **Calendar popover**: at 320-375px, the popover's bounding box stays
  within the viewport width after opening it.

### 6. CI

Add browser-install (`npx playwright install --with-deps chromium`) and
`npx playwright test` steps to
[frontend-tests.yml](../../../.github/workflows/frontend-tests.yml), after
the existing build step (Playwright tests run against the built output).
No new services block is needed since the backend is mocked at the network
layer.

## Verification

No visual-regression/e2e infra exists in the repo yet as of this design
(only Vitest + Testing Library) — this pass adds the functional Playwright
layer described above. Beyond the automated tests, verification includes a
manual pass: resize the browser to 375px, ~390-430px, and 768px and confirm
each of the four fixes visually and functionally, plus a quick check at
existing desktop widths to confirm no regression.

## Files touched

- `frontend/src/components/Header.tsx`, `frontend/src/header.css`
- `frontend/src/App.css` (`.puzzle-page--panel-open` and descendants)
- `frontend/src/benchmark.css`, `frontend/src/components/benchmark/StrategyTable.tsx`
  (wrapper markup only)
- `frontend/playwright.config.ts` (new), `frontend/e2e/*` (new),
  `frontend/package.json` (new devDependency + script)
- `.github/workflows/frontend-tests.yml`
