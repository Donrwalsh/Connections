# Candidate 9 — `useResource`/`useResources` data-fetching hooks: implementation spec

**Origin:** This spec was produced in a grilling/planning session (the `grill-me` skill), not
through the Superpowers spec workflow. It realises the architecture-deepening artifact
`docs/architecture/09-frontend-fetch-hook.html`.

**Branch:** `refactor/use-resource-hook`, off `master`.

**Shape of delivery:** 1 PR, multiple commits (grouped by call-site family, not one-per-file).

---

## Goal

`frontend/src/` has 18 `new AbortController()` call sites across 13 files, each hand-rolling the
same fetch lifecycle: three `useState`s, an effect with a dependency array, an abort-on-unmount
cleanup, and an `AbortError` swallow in the catch. The blocks have already silently diverged (some
reset `data` to `null` on dep change, some don't; one component hand-rolls `Record<key, T>` maps
for a six-way parallel fetch; two components thread a `refreshSignal` integer by hand as a
poor-man's `refetch()`).

Deletion test: replace all 18 blocks with `useResource(key, fetcher)` / `useResources(key, ids,
fetcher)`. The abort/reset/race/loading/error handling concentrates into two hooks; each component
drops to a few lines. Nothing moves to a call site — it moves *out* of every call site.

---

## Scope

### In scope

- New `frontend/src/hooks/useResource.ts` — single-resource fetch hook.
- New `frontend/src/hooks/useResources.ts` — parallel keyed-list fetch hook (for
  `GuessSequencePanel`'s per-strategy fan-out).
- Migrating all 17 GET-read `AbortController` sites (of the 18 total) to one of the two hooks.
- Deleting the `runsRefreshSignal` state/prop entirely from `PuzzleRunsPage.tsx` (self-owned
  trigger → replaced by calling the runs-list resource's own `refetch()`).
- Hook unit tests (`hooks/__tests__/useResource.test.ts`, `useResources.test.ts`), styled after the
  existing `hooks/__tests__/useConnectionsGame.test.ts` (Vitest + `@testing-library/react`
  `renderHook`/`act`).

### Out of scope

| Item | Why deferred |
|---|---|
| `components/Game.tsx`'s AI-solve `AbortController` (site 7, raw `fetch()` POST `/api/diagnose`) | Imperative action tied to `gameReducer` dispatches (`aiSolveSuccess`/`aiSolveError`), not a declarative read — forcing it into `useResource` would fight the reducer pattern it already has. |
| TanStack Query or any other fetch/cache library | App is ~13 endpoints, mostly one-shot reads; doesn't justify the dependency yet. Revisit only if a real shared-cache need appears (e.g. leaderboard + run pages needing to share/invalidate the same data). |
| Mutation call sites (POST/PUT/DELETE) beyond `Game.tsx` | The fact-check below found none among the other 17 — every other site is a plain GET read. If one surfaces later, it's a separate concern; `useResource` is a read-lifecycle hook by design. |
| `isRefetching` (background-refetch-in-progress) flag | None of the 18 call sites have overlay-spinner UI today. YAGNI — add later if a component actually needs to distinguish "no data yet" from "stale data, refetching." |

---

## Fact-check (resolves the artifact's open questions)

An `Explore` pass over all 18 sites (2026-09-11) found:

- **All 16 wrapper fetch functions + the 2 raw-`fetch()` sites already accept and forward
  `signal?: AbortSignal`** (confirmed in `frontend/src/data/benchmark/api.ts`'s `fetchJson`/
  `fetchJsonAdmin`, and in `PuzzlePage.tsx`/`Game.tsx`'s raw calls). No site needs a fetcher
  signature change to fit `useResource`'s `(signal: AbortSignal) => Promise<T>` contract.
- **Only 1 of the 18 sites is not a GET read**: `Game.tsx`'s `/api/diagnose` POST (excluded, see
  Scope above). The other 17 are plain reads.
- **6 of the 17 read sites are `setInterval`-driven polls**, not one-shot reads:
  `CategoryJudgingWidget`, `GoogleDispatchWidget`, `GroqDispatchWidget`, `MistralDispatchWidget`,
  `OpenRouterDispatchWidget`, `SambaNovaDispatchWidget`, plus `FreeTierBudgetWidget`'s
  dispatch-status effect (7 polling sites total, one of which — `FreeTierBudgetWidget` — also
  carries the `refreshSignal` convention). This is why `useResource` needs `opts.refetchInterval`
  (Design, below) — without it, 7 of 17 sites stay unconverted and the "18 copies → 1 hook" premise
  falls apart.
- **`GuessSequencePanel`'s list effect (site 8)** fetches one list per strategy (currently 9,
  hardcoded in `STRATEGIES`) in parallel via a hand-rolled `Record<string, T>` map across three
  separate state triples — this is `useResources`'s reason to exist.

---

## Design

### `useResource`

```ts
// hooks/useResource.ts
export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch: () => void;
}

export interface UseResourceOpts {
  enabled?: boolean;          // default true
  keepPreviousData?: boolean; // default false
  refetchInterval?: number;   // ms; unset = no polling
}

export function useResource<T>(
  key: unknown,                                  // stringified internally, see below
  fetcher: (signal: AbortSignal) => Promise<T>,
  opts?: UseResourceOpts,
): Resource<T>;
```

Behind the seam:

- **Key identity**: the hook `JSON.stringify`s `key` internally and re-fetches on stringified-key
  change, so callers pass array/object literals inline (`useResource(["runDetail", runId], ...)`)
  without needing `useMemo`. No structural-equality footgun exposed to call sites.
- **Race safety**: one `AbortController` per fetch attempt plus a monotonic request-id counter; a
  resolve/reject from a superseded attempt (stale key, or a `refetch()`/interval tick that fired a
  newer attempt) is ignored, not just aborted-and-ignored — covers the case where an abort races a
  resolve that was already in flight past the point `AbortSignal` can stop it.
- **State reset on key change**: `data`/`error` reset to `undefined` on a key change, *unless*
  `keepPreviousData` is true, in which case the previous `data`/`error` stick around (stale) while
  `loading` flips true for the new fetch. This is a deliberate simple contract — no separate
  `isRefetching` flag (see Scope).
- **Error normalization**: `catch (err) { error = err instanceof Error ? err : new Error(String(err)); }`
  after filtering `AbortError`/an aborted signal (silently ignored, matches all 18 existing blocks).
  Keeps `error: Error | undefined` an actual guarantee, not `unknown`.
- **`enabled: false`**: skips fetching entirely; **preserves** whatever `data`/`error` was last
  there rather than clearing it (supports "don't fetch until a modal opens, but keep showing the
  prior result"). Flipping `enabled` false→true fetches immediately on that render.
- **`refetch()`**: aborts the in-flight attempt (if any) and starts a fresh one immediately — same
  code path as a key change. If `refetchInterval` is set, the interval's own schedule is
  *unaffected* by a manual `refetch()` (simplicity — no interval-reset bookkeeping).
- **`refetchInterval`**: when set, an interval timer calls the same internal "run one fetch"
  function on the given cadence, in addition to the initial fetch and any key changes. Cleared on
  unmount and whenever `enabled` is false.

### `useResources`

```ts
// hooks/useResources.ts
export function useResources<K extends string, T>(
  key: unknown,                                          // e.g. `date` — a change refetches every id
  ids: readonly K[],                                     // e.g. STRATEGIES.map(s => s.id) — stable list
  fetcher: (id: K, signal: AbortSignal) => Promise<T>,
  opts?: UseResourceOpts,
): Record<K, Resource<T>>;
```

A thin fan-out over the same internal machinery as `useResource`: one `AbortController`/request-id
per `id`, all sharing the outer `key`'s reset/refetch timing (a `key` change resets and refetches
every `id` in parallel; each `id`'s own `Resource<T>` entry has its own `refetch()` for
per-strategy retry, unused today but free). `GuessSequencePanel`'s three-state-triple
`Record<string, T>`/`Record<string, boolean>`/`Record<string, string>` juggling collapses to one
`useResources(date, STRATEGIES.map(s => s.id), (id, signal) => fetchRunsForStrategyDate(id, date, signal))`
call.

### The `refreshSignal` convention — two different shapes, one real fix

The artifact and the grilling session both call out `refreshSignal` as dead weight to remove, but
the 18 sites split into two genuinely different cases:

- **`PuzzleRunsPage.tsx` (sites 4–5, self-owned trigger)**: the component that bumps
  `runsRefreshSignal` (after `GuessChainVisualizer`'s delete-run callback) is the *same* component
  that owns the runs-list fetch. The integer state and its effect-dependency threading are pure
  overhead — replaced outright by calling the runs-list `useResource`'s own `refetch()` from
  `handleRunDeleted`. `runsRefreshSignal` is deleted, no replacement prop.
- **`FreeTierBudgetWidget.tsx` (site 18, cross-component trigger)**: the trigger originates in a
  *sibling* (`FreeTierDispatchModal`, via `ActivityPage`'s `dispatchRefreshSignal` state) — the
  widget does not own the action that should cause its refetch, so the `refreshSignal` **prop
  itself cannot be deleted**; some signal must still cross the component boundary. What *is*
  deleted is the hand-rolled effect-dependency plumbing: the prop value now just becomes part of
  the `useResource` key (`[tier, refreshSignal]`), so a parent bump still triggers a refetch, but
  through the hook's normal key-change path instead of a bespoke `setInterval`-plus-dependency-array
  block. This is a refinement of "delete outright," not a reversal of it — the *boilerplate* dies;
  the cross-component signal, which is inherent to the data flow, does not.

---

## Steps

All on `refactor/use-resource-hook`, one PR, separate commits per group:

**Commit 1 — `useResource` hook + tests.** `hooks/useResource.ts`, `hooks/__tests__/useResource.test.ts`
covering: key change aborts the prior call and refetches; a stale resolve (superseded by a newer
key/refetch/interval tick before it settles) is ignored; `refetch()` re-runs with a fresh id;
unmount aborts; `enabled:false` skips fetching and preserves prior data, fetches on flip to true;
`keepPreviousData` keeps stale `data` visible while `loading` is true; non-`Error` throws normalize
to `Error`; `refetchInterval` fires repeated fetches on cadence and clears on unmount.

**Commit 2 — `useResources` hook + tests.** `hooks/useResources.ts`,
`hooks/__tests__/useResources.test.ts` covering: parallel fetch across a stable `ids` list; outer
`key` change resets/refetches all ids; per-id `refetch()` doesn't disturb sibling ids.

**Commit 3 — Migrate plain single-read sites** (no polling, no `refreshSignal`):
`GuessChainVisualizer.tsx` (site 13), `pages/PuzzlePage.tsx` (site 1),
`pages/benchmark/StrategyPuzzlePage.tsx` (sites 2–3: `fetchLeaderboard`, `fetchRunHistory`),
`data/benchmark/useStrategyMeta.ts` (site 6: `fetchSupportedModels`),
`GuessSequencePanel.tsx`'s per-run detail effect (site 9), `FreeTierBudgetWidget.tsx`'s token-usage
effect (site 17).

**Commit 4 — Migrate `GuessSequencePanel`'s list effect (site 8) to `useResources`.** Collapses the
`strategyRuns`/`loadingStrategies`/`errorMessages` triple to one `useResources` call; component
reads `results[activeStrategy].data/.loading/.error`.

**Commit 5 — Migrate `PuzzleRunsPage.tsx` (sites 4–5).** `fetchPuzzleDate` and
`fetchRunsForPuzzle` become `useResource` calls; `runsRefreshSignal` state deleted;
`handleRunDeleted` calls the runs resource's `refetch()` directly (see Design, above).

**Commit 6 — Migrate `FreeTierBudgetWidget.tsx`'s dispatch-status poll (site 18).** `useResource`
with `refetchInterval: DISPATCH_STATUS_POLL_MS`; `refreshSignal` prop retained, folded into the
hook's key (see Design). `stopFreeTierDispatch`'s own imperative call (not an `AbortController`
site) is unchanged.

**Commit 7 — Migrate the 6 polling widgets** (`CategoryJudgingWidget`, `GoogleDispatchWidget`,
`GroqDispatchWidget`, `MistralDispatchWidget`, `OpenRouterDispatchWidget`,
`SambaNovaDispatchWidget`) to `useResource` with `refetchInterval`.

**Commit 8 — Cleanup pass.** Grep `frontend/src` for `new AbortController()` — the only remaining
match should be `Game.tsx` (excluded by design). Run `npm run test` (frontend) and confirm every
touched component test still passes; update any test that mocked the old `AbortController` timing
directly rather than the fetcher function.

---

## Tests

Characterisation-first, matching candidates 1, 5, and 8's approach:

- The two hook test files (Commits 1–2) carry the hard cases — race safety, abort, key-change
  reset, `keepPreviousData`, `enabled`, `refetchInterval` — once, replacing the same assertions
  half-written (or entirely absent, e.g. no current test proves `GuessChainVisualizer`'s abort
  cleanup actually aborts) across up to 13 component test files.
- Component tests shrink to "given this resolved/pending/error state, render this" — no
  `AbortController` mocking, no fake-timer races, since the hook's four-field (or `refetchInterval`
  for polling) contract is the whole surface a component test needs to drive.
- `PuzzleRunsPage.test.tsx` and `FreeTierBudgetWidget.test.tsx` (if they assert on the
  `refreshSignal`/`runsRefreshSignal` mechanism directly) get updated to assert on the observable
  behavior (refetch happens after delete / after a dispatch starts) rather than the removed
  intermediate state variable.

---

## Risks

- **`react-hooks/exhaustive-deps` is `'warn'`, not off**, in this repo's ESLint config — the hooks'
  internal effects must declare correct dependencies (the stringified key, `enabled`,
  `refetchInterval`) or justify a suppression; a wrong dep array here would reintroduce exactly the
  stale-closure bugs this candidate exists to remove.
- **No TS `strict`/`strictNullChecks`** in `frontend/tsconfig.app.json` — the hooks' own types
  (`T | undefined` fields) must be written carefully by hand, since the compiler won't catch a
  missed `undefined` check the way it would under strict mode.
- **`FreeTierBudgetWidget`'s `refreshSignal` prop survives** (see Design) — a future reader
  expecting the artifact's "no `refreshSignal` integer" framing to be universal should check the
  Design section's two-shapes note rather than assume every instance of the convention was deleted.
- **Single large PR** (8 commits, 13 files, 2 new files) — mitigated by strict commit-per-family
  grouping (each commit independently buildable/testable) and the hook tests landing first (Commits
  1–2), so every later commit is a mechanical swap against an already-proven hook rather than
  new logic.
- **`GuessSequencePanel`'s `fetchedRunIds` ref-based "already cached" guard** (site 9, skips
  refetching a run's detail once loaded) has no direct `useResource` equivalent — `useResource`
  refetches on every key change by design. Preserved by keying the per-run detail `useResource`
  call on `selectedRun?.id` and leaving the existing `isOpen` gate (`enabled: isOpen && !!selectedRun`)
  as the hook's `enabled` option; the ref-guard's caching behavior becomes `keepPreviousData` at the
  `useResources` map level instead of a manual ref — worth double-checking in review that this
  doesn't reintroduce a refetch-on-every-reopen regression the ref guard was preventing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
