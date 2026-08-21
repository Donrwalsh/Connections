# Mobile Responsive Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the header nav, the game page's AI-assist/guess-sequence panel, the leaderboard table, and the calendar popover usable and not visually broken at phone widths, and lock in that behavior with functional Playwright tests.

**Architecture:** Four independent CSS/markup fixes (no new breakpoint system — all reuse the existing `max-width: 640px` convention already used in `header.css`/`benchmark.css`), each paired with a Playwright test written first (TDD: red against current markup, green after the fix). A final task wires Playwright into CI.

**Tech Stack:** React 19 + TypeScript, plain CSS (no framework), Vitest + Testing Library (existing unit tests), Playwright (new, functional/interaction tests only — no visual regression).

**Spec:** [docs/superpowers/specs/2026-08-21-mobile-responsive-fixes-design.md](../specs/2026-08-21-mobile-responsive-fixes-design.md)

## Global Constraints

- Reuse the existing `@media (max-width: 640px)` breakpoint convention already established in `header.css` and `benchmark.css` — do not introduce a new breakpoint system.
- No new CSS framework.
- Playwright tests are functional/interaction only — no screenshot baselines, no visual-regression/pixel-diffing.
- Playwright tests mock the backend at the network layer via `page.route()` (matching how existing Vitest tests already mock `fetch`) — no live backend, database, or CI service containers.
- In scope: the game page (board + guess-sequence panel), the shared header/calendar popover, and the top-level `/leaderboard` table. Out of scope: the benchmark drill-down pages (strategy detail, puzzle runs, activity feed) beyond not being broken, and DESIGN.md's full mobile visual spec (leaderboard 2-line card collapse, calendar cell-degradation order, hero rewrap tuning) — both explicitly deferred per the spec.
- Build frontend with `VITE_API_URL=""` for Playwright's preview server so API calls resolve to clean same-origin absolute paths (e.g. `/game/puzzle/today`) that `page.route()` glob patterns can match reliably, regardless of the current route.

---

## Task 1: Playwright test infrastructure + fixtures

**Files:**
- Create: `frontend/playwright.config.ts`
- Create: `frontend/e2e/fixtures.ts`
- Create: `frontend/e2e/smoke.spec.ts`
- Modify: `frontend/package.json` (new devDependency, new `test:e2e` script)

**Interfaces:**
- Produces: `puzzleFixture: Puzzle` (from `../src/data/types`), `leaderboardFixture: Leaderboard` (from `../src/data/benchmark/types`), `mockPuzzle(page): Promise<void>`, `mockGuessSequenceRuns(page): Promise<void>`, `mockLeaderboard(page): Promise<void>` — all exported from `frontend/e2e/fixtures.ts`, consumed by Tasks 2-5.

- [ ] **Step 1: Install Playwright**

Run from `frontend/`:

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

- [ ] **Step 2: Create `frontend/playwright.config.ts`**

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
  },
  webServer: {
    // Rebuilds on every run so `npm run test:e2e` is self-contained locally
    // and in CI, regardless of whether a prior build step already ran.
    command: "npm run build && npm run preview -- --port 4173",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    env: {
      // Empty (not unset) so import.meta.env.VITE_API_URL resolves API
      // calls to clean same-origin absolute paths like "/game/puzzle/today"
      // instead of the literal string "undefined/game/puzzle/today".
      VITE_API_URL: "",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
```

- [ ] **Step 3: Create `frontend/e2e/fixtures.ts`**

```ts
import type { Page } from "@playwright/test";
import type { Category, Puzzle } from "../src/data/types";
import type { FreeTierUsage, Leaderboard, LeaderboardRow } from "../src/data/benchmark/types";

const categories: Category[] = [
  { id: "cat-1", name: "WET WEATHER", difficulty: "yellow", words: ["HAIL", "RAIN", "SLEET", "SNOW"] },
  { id: "cat-2", name: "NBA TEAMS", difficulty: "green", words: ["BUCKS", "HEAT", "JAZZ", "NETS"] },
  { id: "cat-3", name: "KEYBOARD KEYS", difficulty: "blue", words: ["OPTION", "RETURN", "SHIFT", "TAB"] },
  { id: "cat-4", name: "PALINDROMES", difficulty: "purple", words: ["KAYAK", "LEVEL", "MOM", "RACECAR"] },
];

export const puzzleFixture: Puzzle = {
  id: 1,
  date: "2024-01-15",
  categories,
  wordOrder: categories.flatMap((c) => c.words),
  isImagePuzzle: false,
};

function makeRow(overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    id: "alphabetical",
    strategyName: "alphabetical",
    modelName: null,
    kind: "deterministic",
    puzzlesCovered: 10,
    totalPuzzles: 12,
    progress: { completed: 10, active: 0, failed: 0, queued: 0 },
    successRate: 100,
    avgGuessesToSolve: 12,
    minGuesses: 4,
    maxGuesses: 40,
    avgDurationMs: 12,
    avgCostUsd: null,
    totalCostUsd: null,
    ...overrides,
  };
}

export const leaderboardFixture: Leaderboard = {
  deterministic: [
    makeRow({ id: "alphabetical", strategyName: "alphabetical" }),
    makeRow({
      id: "shuffle-foolish",
      strategyName: "shuffle-foolish",
      successRate: 60,
      avgGuessesToSolve: 30,
    }),
  ],
  llm: [
    makeRow({
      id: "gpt-4.1-nano-2025-04-14",
      strategyName: "llm-openai",
      modelName: "gpt-4.1-nano-2025-04-14",
      kind: "llm",
      successRate: 80,
      avgGuessesToSolve: 4.2,
      minGuesses: 2,
      maxGuesses: 8,
      avgCostUsd: 0.1234,
      totalCostUsd: 0.4936,
    }),
  ],
};

const flagshipUsage: FreeTierUsage = {
  tier: "flagship",
  label: "Flagship models",
  usedTokens: 12_000,
  dailyLimitTokens: 250_000,
  remainingTokens: 238_000,
  models: ["gpt-4.1"],
};

const miniUsage: FreeTierUsage = {
  tier: "mini",
  label: "Mini & nano models",
  usedTokens: 500_000,
  dailyLimitTokens: 2_500_000,
  remainingTokens: 2_000_000,
  models: ["gpt-4.1-nano"],
};

/** Mocks the /game/puzzle/* endpoint PuzzlePage fetches, for both
 * /puzzle/:date and the today-alias route. */
export async function mockPuzzle(page: Page): Promise<void> {
  await page.route("**/game/puzzle/**", (route) => route.fulfill({ json: puzzleFixture }));
}

/** Mocks every per-strategy run-list endpoint GuessSequencePanel fetches on
 * mount with an empty list — enough to exercise the panel's open/stack
 * behavior without needing real run data. */
export async function mockGuessSequenceRuns(page: Page): Promise<void> {
  await page.route("**/strategy/*/puzzle/*", (route) => route.fulfill({ json: [] }));
}

/** Mocks the leaderboard plus both free-tier-usage endpoints LeaderboardPage
 * fetches on load. */
export async function mockLeaderboard(page: Page): Promise<void> {
  await page.route("**/strategy/leaderboard", (route) => route.fulfill({ json: leaderboardFixture }));
  await page.route("**/strategy/free-tier-usage/flagship", (route) => route.fulfill({ json: flagshipUsage }));
  await page.route("**/strategy/free-tier-usage/mini", (route) => route.fulfill({ json: miniUsage }));
}
```

- [ ] **Step 4: Create `frontend/e2e/smoke.spec.ts`**

```ts
import { test, expect } from "@playwright/test";
import { mockLeaderboard, mockPuzzle } from "./fixtures";

test("the app boots and the shared header renders", async ({ page }) => {
  await mockLeaderboard(page);
  await mockPuzzle(page);
  await page.goto("/leaderboard");

  await expect(page.getByRole("link", { name: "Connections Lab" })).toBeVisible();
  await expect(page.getByText("Alphabetical")).toBeVisible();
});
```

- [ ] **Step 5: Add the `test:e2e` script**

In `frontend/package.json`, add to `"scripts"`:

```json
"test:e2e": "playwright test"
```

- [ ] **Step 6: Run the smoke test**

Run: `npm run test:e2e` (from `frontend/`)
Expected: PASS (1 test) — this proves the build, preview server, route mocking, and browser launch all work end-to-end before any fixes are built on top of it.

- [ ] **Step 7: Commit**

```bash
git add frontend/playwright.config.ts frontend/e2e/fixtures.ts frontend/e2e/smoke.spec.ts frontend/package.json frontend/package-lock.json
git commit -m "test: add Playwright functional test infrastructure"
```

---

## Task 2: Header nav — icon-only collapse at mobile width

**Files:**
- Modify: `frontend/src/components/Header.tsx`
- Modify: `frontend/src/header.css`
- Modify: `frontend/src/components/__tests__/Header.test.tsx`
- Create: `frontend/e2e/header.spec.ts`

**Interfaces:**
- Consumes: `mockLeaderboard`, `mockPuzzle` from `./fixtures` (Task 1).

- [ ] **Step 1: Write the failing Playwright test**

Create `frontend/e2e/header.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { mockLeaderboard, mockPuzzle } from "./fixtures";

test.describe("header nav responsiveness", () => {
  test("collapses nav labels to icon-only at mobile width", async ({ page }) => {
    await mockLeaderboard(page);
    await mockPuzzle(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/leaderboard");

    const todayLink = page.getByRole("link", { name: "Today's puzzle" });
    await expect(todayLink).toBeVisible();
    await expect(todayLink.locator(".site-header__link-label")).toBeHidden();

    await todayLink.click();
    await expect(page).toHaveURL("/");
  });

  test("keeps nav labels visible at desktop width", async ({ page }) => {
    await mockLeaderboard(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/leaderboard");

    const todayLink = page.getByRole("link", { name: "Today's puzzle" });
    await expect(todayLink.locator(".site-header__link-label")).toBeVisible();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:e2e -- header.spec.ts`
Expected: FAIL — `.site-header__link-label` doesn't exist yet, so `toBeHidden()`/`toBeVisible()` can't locate it.

- [ ] **Step 3: Write the failing Vitest unit test**

In `frontend/src/components/__tests__/Header.test.tsx`, add after the `"shows the wordmark and all nav items"` test:

```tsx
  it("gives icon-only nav links an explicit aria-label", () => {
    renderHeader();

    expect(screen.getByRole("link", { name: "Today's puzzle" })).toHaveAttribute(
      "aria-label",
      "Today's puzzle",
    );
    expect(screen.getByRole("link", { name: "Leaderboard" })).toHaveAttribute(
      "aria-label",
      "Leaderboard",
    );
    expect(screen.getByRole("link", { name: "Activity" })).toHaveAttribute("aria-label", "Activity");
  });
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npm run test:run -- Header.test.tsx` (from `frontend/`)
Expected: FAIL — no `aria-label` attribute exists on the links yet.

- [ ] **Step 5: Implement the fix in `Header.tsx`**

Replace the three `NavLink`s in `frontend/src/components/Header.tsx`:

```tsx
        <NavLink to="/" end className={navLinkClass} aria-label="Today's puzzle">
          <GridIcon />
          <span className="site-header__link-label">Today's puzzle</span>
        </NavLink>
```

```tsx
        <NavLink to="/leaderboard" className={navLinkClass} aria-label="Leaderboard">
          <LeaderboardIcon />
          <span className="site-header__link-label">Leaderboard</span>
        </NavLink>

        <NavLink to="/activity" className={navLinkClass} aria-label="Activity">
          <ActivityIcon />
          <span className="site-header__link-label">Activity</span>
        </NavLink>
```

- [ ] **Step 6: Implement the fix in `header.css`**

In the existing `@media (max-width: 640px)` block at the end of `frontend/src/header.css`, add a rule:

```css
@media (max-width: 640px) {
  .site-header {
    padding: 0 0.5rem;
  }

  .site-header__wordmark {
    font-size: 1rem;
  }

  .site-header__link {
    padding: 0.6rem 0.4rem;
    font-size: 0.85rem;
  }

  .site-header__link-label {
    display: none;
  }

  .site-header__calendar {
    order: 2;
  }
}
```

(Only the `.site-header__link-label` rule is new — the rest of the block is unchanged, shown for placement context.)

- [ ] **Step 7: Run both tests to verify they pass**

Run: `npm run test:run -- Header.test.tsx && npm run test:e2e -- header.spec.ts`
Expected: PASS

- [ ] **Step 8: Run the full Vitest suite to check for regressions**

Run: `npm run test:run` (from `frontend/`)
Expected: PASS — confirms the new `aria-label`s don't break any other test that queries these links by accessible name.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/Header.tsx frontend/src/header.css frontend/src/components/__tests__/Header.test.tsx frontend/e2e/header.spec.ts
git commit -m "fix: collapse header nav to icon-only at mobile width"
```

---

## Task 3: Guess-sequence panel — stack below the board at mobile width

**Files:**
- Modify: `frontend/src/App.css`
- Create: `frontend/e2e/guess-panel.spec.ts`

**Interfaces:**
- Consumes: `mockPuzzle`, `mockGuessSequenceRuns` from `./fixtures` (Task 1).

- [ ] **Step 1: Write the failing Playwright test**

Create `frontend/e2e/guess-panel.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { mockGuessSequenceRuns, mockPuzzle } from "./fixtures";

test.describe("guess-sequence panel responsiveness", () => {
  test("stacks below the board at mobile width when opened", async ({ page }) => {
    await mockPuzzle(page);
    await mockGuessSequenceRuns(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/puzzle/2024-01-15");

    await page.getByRole("button", { name: /Show Alphabetical/ }).click();
    // Wait for the panel's content to actually render before measuring
    // layout — the click only triggers a state update, and reading
    // boundingBox() immediately after could catch a stale pre-render frame.
    await expect(page.locator(".guess-sequence__content")).toBeVisible();

    const board = page.locator(".puzzle-page__board");
    const panel = page.locator(".puzzle-page__panel");
    const boardBox = await board.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(boardBox).not.toBeNull();
    expect(panelBox).not.toBeNull();

    // Stacked: the panel starts at/below the board's bottom edge.
    expect(panelBox!.y).toBeGreaterThanOrEqual(boardBox!.y + boardBox!.height - 1);
    // The board keeps a normal (unscaled) width instead of the desktop
    // side-by-side layout's fixed 500px-scaled-to-80% canvas.
    expect(boardBox!.width).toBeGreaterThan(300);
  });

  test("sits beside the board at desktop width when opened", async ({ page }) => {
    await mockPuzzle(page);
    await mockGuessSequenceRuns(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/puzzle/2024-01-15");

    await page.getByRole("button", { name: /Show Alphabetical/ }).click();
    await expect(page.locator(".guess-sequence__content")).toBeVisible();

    const board = page.locator(".puzzle-page__board");
    const panel = page.locator(".puzzle-page__panel");
    const boardBox = await board.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(boardBox).not.toBeNull();
    expect(panelBox).not.toBeNull();

    // Side-by-side: the panel starts at/right of the board's right edge.
    expect(panelBox!.x).toBeGreaterThanOrEqual(boardBox!.x + boardBox!.width - 1);
  });
});
```

- [ ] **Step 2: Run it to verify the mobile case fails**

Run: `npm run test:e2e -- guess-panel.spec.ts`
Expected: The mobile test FAILs (panel currently renders beside the board, scaled, with the page clipped) while the desktop test passes.

- [ ] **Step 3: Implement the fix in `App.css`**

In `frontend/src/App.css`, add a new `@media (max-width: 640px)` block immediately after the existing `.puzzle-page--panel-open` rules (after the block ending at line 253, before `.guess-sequence`):

```css
@media (max-width: 640px) {
  .puzzle-page--panel-open {
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    max-width: 100%;
    height: auto;
    overflow: visible;
  }

  .puzzle-page--panel-open .puzzle-page__board {
    position: static;
    transform: none;
    margin-top: 0;
    width: 100%;
    max-width: 500px;
    max-height: none;
    overflow: visible;
  }

  .puzzle-page--panel-open .puzzle-page__panel {
    height: auto;
    overflow-y: visible;
    padding-right: 0;
  }

  .puzzle-page--panel-open .tile {
    font-size: 0.95rem;
  }
}
```

The last rule overrides the existing unconditional `.puzzle-page--panel-open .tile { font-size: 0.7rem; }` (near the end of the file) back to a normal size at mobile width, since the board is no longer scaled down there.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:e2e -- guess-panel.spec.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.css frontend/e2e/guess-panel.spec.ts
git commit -m "fix: stack the guess-sequence panel below the board at mobile width"
```

---

## Task 4: Leaderboard table — horizontal scroll wrapper at mobile width

**Files:**
- Modify: `frontend/src/components/benchmark/StrategyTable.tsx`
- Modify: `frontend/src/benchmark.css`
- Create: `frontend/e2e/leaderboard-table.spec.ts`

**Interfaces:**
- Consumes: `mockLeaderboard` from `./fixtures` (Task 1).

- [ ] **Step 1: Write the failing Playwright test**

Create `frontend/e2e/leaderboard-table.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { mockLeaderboard } from "./fixtures";

test.describe("leaderboard table responsiveness", () => {
  test("scrolls horizontally inside its wrapper at mobile width", async ({ page }) => {
    await mockLeaderboard(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/leaderboard");

    const wrap = page.locator(".bench-table-wrap").first();
    await expect(wrap).toBeVisible();

    const scrollWidth = await wrap.evaluate((el) => el.scrollWidth);
    const clientWidth = await wrap.evaluate((el) => el.clientWidth);
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    // The wrapper itself never exceeds the viewport — it's the thing that
    // scrolls, not the page.
    const wrapBox = await wrap.boundingBox();
    expect(wrapBox).not.toBeNull();
    expect(wrapBox!.width).toBeLessThanOrEqual(375);
  });

  test("a row still navigates to the strategy detail page at mobile width", async ({ page }) => {
    await mockLeaderboard(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/leaderboard");

    await page.getByRole("link", { name: "View Alphabetical details" }).click();
    await expect(page).toHaveURL("/leaderboard/alphabetical");
  });
});
```

- [ ] **Step 2: Run it to verify the first test fails**

Run: `npm run test:e2e -- leaderboard-table.spec.ts`
Expected: The first test FAILs (`.bench-table-wrap` doesn't exist yet); the second passes already since row navigation is unaffected by this change.

- [ ] **Step 3: Implement the fix in `StrategyTable.tsx`**

In `frontend/src/components/benchmark/StrategyTable.tsx`, wrap the returned `<table>` in a new container. Change:

```tsx
  return (
    <table className="bench-table">
```

to:

```tsx
  return (
    <div className="bench-table-wrap">
    <table className="bench-table">
```

and change the closing tag from:

```tsx
    </table>
  );
}
```

to:

```tsx
    </table>
    </div>
  );
}
```

- [ ] **Step 4: Implement the fix in `benchmark.css`**

In `frontend/src/benchmark.css`, immediately before the existing `.bench-table {` rule, add:

```css
.bench-table-wrap {
  overflow-x: auto;
}

.bench-table {
  width: 100%;
  min-width: 40rem;
  border-collapse: collapse;
  font-size: 0.9rem;
}
```

(Only `.bench-table-wrap` and the added `min-width: 40rem` line are new — `.bench-table`'s other properties are unchanged, shown for placement context. `min-width` is what forces real horizontal scrolling instead of the browser silently crushing columns to fit.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:e2e -- leaderboard-table.spec.ts`
Expected: PASS (both tests)

- [ ] **Step 6: Run the full Vitest suite to check for regressions**

Run: `npm run test:run` (from `frontend/`)
Expected: PASS — confirms the new wrapper `<div>` doesn't break any existing `StrategyTable`/`LeaderboardPage` test that queries the table by role or structure.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/benchmark/StrategyTable.tsx frontend/src/benchmark.css frontend/e2e/leaderboard-table.spec.ts
git commit -m "fix: wrap the leaderboard table in a horizontal-scroll container"
```

---

## Task 5: Calendar popover — stay within the viewport at narrow widths

**Files:**
- Modify: `frontend/src/header.css`
- Create: `frontend/e2e/calendar-popover.spec.ts`

**Interfaces:**
- Consumes: `mockLeaderboard` from `./fixtures` (Task 1).

- [ ] **Step 1: Write the failing Playwright test**

Create `frontend/e2e/calendar-popover.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { mockLeaderboard } from "./fixtures";

test("calendar popover stays within the viewport at a narrow phone width", async ({ page }) => {
  await mockLeaderboard(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/leaderboard");

  await page.getByRole("button", { name: "Calendar" }).click();
  const popover = page.getByRole("dialog", { name: "Calendar" });
  await expect(popover).toBeVisible();

  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:e2e -- calendar-popover.spec.ts`
Expected: FAIL — the popover's fixed 18.5rem (296px) width combined with its `right: 0` anchor and the header's own padding pushes it past the 320px viewport edge.

- [ ] **Step 3: Implement the fix in `header.css`**

In the same `@media (max-width: 640px)` block touched in Task 2, add:

```css
  .calendar-popover {
    width: min(18.5rem, calc(100vw - 1rem));
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:e2e -- calendar-popover.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add frontend/src/header.css frontend/e2e/calendar-popover.spec.ts
git commit -m "fix: cap the calendar popover width to the viewport at narrow phone widths"
```

---

## Task 6: Wire Playwright into CI

**Files:**
- Modify: `.github/workflows/frontend-tests.yml`

**Interfaces:**
- None (CI configuration only).

- [ ] **Step 1: Add Playwright steps to the workflow**

In `.github/workflows/frontend-tests.yml`, add two steps after the existing `"Run tests"` step:

```yaml
      - name: Run tests
        run: npm run test:run

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Run Playwright tests
        run: npm run test:e2e
```

- [ ] **Step 2: Run the full local suite one more time to confirm nothing regressed**

Run (from `frontend/`):

```bash
npm run lint
npm run build
npm run test:run
npm run test:e2e
```

Expected: All four PASS.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/frontend-tests.yml
git commit -m "ci: run Playwright functional tests in frontend CI"
```

---

## Final verification

After Task 6, do the manual pass described in the spec's "Verification" section: resize a real browser to 375px, ~390-430px, and 768px widths and confirm each of the four fixes visually and functionally (header collapses without wrapping, the guess-sequence panel stacks and stays usable, the leaderboard table scrolls instead of crushing, the calendar popover stays on-screen), plus a quick desktop-width check to confirm no regression.
