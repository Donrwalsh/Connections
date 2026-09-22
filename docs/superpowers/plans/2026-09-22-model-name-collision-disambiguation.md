# Model-Name Collision Disambiguation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When two providers' `SupportedModel` rows share the exact same `modelName` (currently: `openai/gpt-oss-20b` under both `llm-groq` and `llm-nvidia`), every code path that resolves a bare model name — the leaderboard detail page, its nested puzzle-runs page, and the table row that links into them — resolves to the correct provider instead of silently picking whichever row sorts first, with no code change required for a *future* collision beyond seeding its `SupportedModel` rows.

**Architecture:** A new backend endpoint (`GET /strategy/models/:modelName/strategy`) reuses the existing, already-tested `SupportedModelService.resolveSupportedStrategy` to give the frontend one canonical, server-enforced answer to "does this bare model name resolve to exactly one provider?". The frontend carries the resolved provider as a `?strategy=` query parameter (not a new path segment — see the spec's "Routing correction") only for rows/links that are actually ambiguous; every other model's URL is untouched. Landing on an ambiguous URL with no qualifier renders a small inline picker instead of guessing.

**Tech Stack:** NestJS (backend), React + React Router v6 (frontend), Jest (backend tests), TypeScript throughout.

**Spec:** `docs/specs/2026-09-22-model-name-collision-disambiguation-design.md`

## Global Constraints

- No change to `SupportedModel`'s schema or uniqueness constraint (spec, Non-goals).
- The two admin `POST /dispatch/model/:modelName/*` routes are not touched (spec, Decision 3).
- The URL for any model that is *not* currently ambiguous must not change at all (spec, Decisions 2 and 9).
- Ambiguity must be computed live from data in every location it's checked — never a hardcoded list of "known colliding models" (spec, Decision 9).
- No new frontend test framework/files are introduced — this codebase has vitest configured but zero existing frontend test files; frontend tasks are verified by type-check + manual browser check (spec, Non-goals).

---

### Task 1: Backend — resolve-model-strategy endpoint

**Files:**
- Modify: `backend/src/modules/strategy/strategy.controller.ts`
- Test: `backend/src/modules/strategy/strategy.controller.spec.ts` (new file)

**Interfaces:**
- Consumes: `SupportedModelService.resolveSupportedStrategy(modelName: string): Promise<string>` — already exists at `backend/src/modules/supported-model/supported-model.service.ts:86-101`, already throws `BadRequestException` on 0 or >1 matches. No change to this method.
- Produces: `GET /strategy/models/:modelName/strategy` → `{ modelName: string, strategyName: string }` on success, propagates the service's `BadRequestException` (400) unchanged otherwise. Consumed by Task 3 (frontend `resolveModelStrategy` client).

- [ ] **Step 1: Write the failing controller test**

Create `backend/src/modules/strategy/strategy.controller.spec.ts`:

```typescript
import { BadRequestException } from "@nestjs/common";
import { StrategyController } from "./strategy.controller";
import type { RunHistoryReadModel } from "./strategy-read.service";
import type { SupportedModelService } from "../supported-model/supported-model.service";
import type { FreeTierUsageService } from "./free-tier-usage.service";

describe("StrategyController", () => {
  function makeController(resolveSupportedStrategy: jest.Mock) {
    const runHistoryReadModel = {} as RunHistoryReadModel;
    const supportedModelService = {
      resolveSupportedStrategy,
    } as unknown as SupportedModelService;
    const freeTierUsageService = {} as FreeTierUsageService;
    return new StrategyController(runHistoryReadModel, supportedModelService, freeTierUsageService);
  }

  describe("resolveModelStrategy", () => {
    it("returns the model and its one resolved strategy", async () => {
      const resolveSupportedStrategy = jest.fn().mockResolvedValueOnce("llm-groq");
      const controller = makeController(resolveSupportedStrategy);

      const result = await controller.resolveModelStrategy("openai/gpt-oss-20b");

      expect(result).toEqual({ modelName: "openai/gpt-oss-20b", strategyName: "llm-groq" });
      expect(resolveSupportedStrategy).toHaveBeenCalledWith("openai/gpt-oss-20b");
    });

    it("propagates the service's ambiguity rejection unchanged", async () => {
      const resolveSupportedStrategy = jest.fn().mockRejectedValueOnce(
        new BadRequestException(
          "Model 'openai/gpt-oss-20b' is ambiguous — it is configured as supported under multiple" +
            " strategies (llm-groq, llm-nvidia).",
        ),
      );
      const controller = makeController(resolveSupportedStrategy);

      await expect(controller.resolveModelStrategy("openai/gpt-oss-20b")).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest strategy.controller.spec.ts`
Expected: FAIL — `controller.resolveModelStrategy is not a function`

- [ ] **Step 3: Add the endpoint**

In `backend/src/modules/strategy/strategy.controller.ts`, add this method directly after `getSupportedModels` (currently lines 28-31), keeping the same "literal-first-segment" placement convention the file already documents for `models`/`leaderboard`:

```typescript
  // Resolves a bare model name to the one strategy it's currently supported
  // under — the same guard the admin dispatch/model/:modelName/* routes
  // already rely on (see SupportedModelService.resolveSupportedStrategy).
  // Lets a /leaderboard/:strategyId page that has no ?strategy= qualifier
  // ask the backend, not just guess client-side, whether the bare model
  // name actually has one answer — throws the same 400 "is ambiguous"/"is
  // not a supported model" error the admin routes throw when it doesn't.
  // Registered under "models/" (a literal segment, like "models" and
  // "leaderboard" above) so it can't collide with the :strategyName/...
  // routes below regardless of registration order.
  @Get("models/:modelName/strategy")
  @ApiParam({
    name: "modelName",
    type: String,
    description:
      "A model name from the SupportedModel table. Resolves to the one strategy it's currently" +
      " supported under — rejected with 400 if the model is unknown, unsupported, or configured" +
      " under more than one strategy.",
    example: "openai/gpt-oss-20b",
  })
  async resolveModelStrategy(@Param("modelName") modelName: string) {
    const strategyName = await this.supportedModelService.resolveSupportedStrategy(modelName);
    return { modelName, strategyName };
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest strategy.controller.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/strategy.controller.ts backend/src/modules/strategy/strategy.controller.spec.ts
git commit -m "feat(backend): add GET /strategy/models/:modelName/strategy resolve endpoint"
```

---

### Task 2: Frontend — API client + type for the resolve endpoint

**Files:**
- Modify: `frontend/src/data/benchmark/api.ts`
- Modify: `frontend/src/data/benchmark/types.ts`

**Interfaces:**
- Produces: `resolveModelStrategy(modelName: string, signal?: AbortSignal): Promise<ResolvedModelStrategy>`, type `ResolvedModelStrategy = { modelName: string; strategyName: string }`. Consumed by Task 3.

- [ ] **Step 1: Add the type**

In `frontend/src/data/benchmark/types.ts`, add near `SupportedModelRecord` (after its closing brace, currently line 238):

```typescript
/** Response from GET /strategy/models/:modelName/strategy — the one
 * strategy a bare model name currently resolves to. The request rejects
 * (thrown Error, message from the backend) if the model is unknown,
 * unsupported, or configured under more than one strategy — see
 * useStrategyMeta, which is this call's only consumer. */
export interface ResolvedModelStrategy {
  modelName: string;
  strategyName: string;
}
```

- [ ] **Step 2: Add the API client function**

In `frontend/src/data/benchmark/api.ts`, add the `ResolvedModelStrategy` import to the existing type-only import block (after `RunStatus,` around line 29), and add this function directly after `fetchSupportedModels` (currently lines 177-179):

```typescript
/** Resolves a bare model name to the one strategy it's currently supported
 * under — the backend enforcement useStrategyMeta relies on when a
 * /leaderboard/:strategyId page has no ?strategy= qualifier telling it which
 * provider was meant. Rejects (thrown Error, message from the backend) if
 * the model is unknown, unsupported, or configured under more than one
 * strategy — see resolveSupportedStrategy on the backend. */
export function resolveModelStrategy(
  modelName: string,
  signal?: AbortSignal,
): Promise<ResolvedModelStrategy> {
  return fetchJson(`/strategy/models/${encodeURIComponent(modelName)}/strategy`, signal);
}
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/data/benchmark/api.ts frontend/src/data/benchmark/types.ts
git commit -m "feat(frontend): add resolveModelStrategy API client"
```

---

### Task 3: Frontend — ambiguity-aware `useStrategyMeta`

**Files:**
- Modify: `frontend/src/data/benchmark/useStrategyMeta.ts`

**Interfaces:**
- Consumes: `resolveModelStrategy` (Task 2), `fetchSupportedModels` (existing), `SupportedModelRecord`/`ResolvedModelStrategy` types.
- Produces: `useStrategyMeta(strategyId: string | undefined, strategyQualifier?: string): { meta: StrategyMeta | undefined; isResolving: boolean; isAmbiguous: boolean; ambiguousCandidates: SupportedModelRecord[] }`. The `isAmbiguous`/`ambiguousCandidates` fields are new; `meta`/`isResolving` keep their existing meaning. Consumed by Task 5 (`StrategyPuzzlePage`) and Task 7 (`PuzzleRunsPage`).

- [ ] **Step 1: Replace the hook**

Replace the full contents of `frontend/src/data/benchmark/useStrategyMeta.ts` with:

```typescript
import { fetchSupportedModels, resolveModelStrategy } from "./api";
import { formatModelStatsDescription } from "./formatModelStats";
import { useResource } from "../../hooks/useResource";
import { getStrategyMeta } from "./mockData";
import { poolFromStrategyName, providerPoolLabel } from "./providerPools";
import type { StrategyMeta, SupportedModelRecord } from "./types";

/** Synthesizes StrategyMeta for a model the static mock catalog doesn't know
 * about, from the real backend allowlist (GET /strategy/models). Only ever
 * needed for LLM rows — deterministic/shuffle strategies are always in the
 * mock catalog already. `runsPerPuzzle` is a placeholder: nothing derives
 * layout from it, so it isn't load-bearing here. */
function buildDynamicMeta(model: SupportedModelRecord): StrategyMeta {
  const pool = poolFromStrategyName(model.strategyName);
  const providerLabel = pool ? providerPoolLabel(pool) : "LLM";
  return {
    id: model.modelName,
    name: `LLM · ${model.modelName}`,
    kind: "llm",
    description: formatModelStatsDescription(
      providerLabel,
      model.modelName,
      model.contextWindow,
      model.paramCount,
    ),
    runsPerPuzzle: 3,
    strategyName: model.strategyName,
  };
}

export interface UseStrategyMetaResult {
  meta: StrategyMeta | undefined;
  isResolving: boolean;
  /** True when `strategyId` names a model more than one provider currently
   * supports and `strategyQualifier` didn't pick one — see
   * ambiguousCandidates for the choices to present. */
  isAmbiguous: boolean;
  /** Populated only when isAmbiguous — every currently-supported
   * SupportedModel row sharing this modelName, for a picker UI to list. */
  ambiguousCandidates: SupportedModelRecord[];
}

/**
 * Resolves a /leaderboard/:strategyId route param to its StrategyMeta. For
 * "llm" kind rows the id is actually a *model name*
 * (e.g. "gpt-4.1-nano-2025-04-14") — see StrategyMeta. Strategy metadata
 * (name/kind/description) primarily comes from the static mock catalog,
 * since the backend has no general "strategy catalog" and that content is
 * effectively UI copy rather than run data; an id the mock list doesn't
 * recognize is checked against the real model allowlist (GET
 * /strategy/models) before giving up — this is what makes a link generated
 * from real backend data (e.g. a model added after the mock list was last
 * updated) resolve correctly instead of always reporting "Unknown strategy".
 * Shared by every /leaderboard/:strategyId... page.
 *
 * `strategyQualifier` is the page's `?strategy=` query param (see
 * StrategyTable/RunHistoryTable, which only ever add it for a model name
 * that's actually ambiguous). When given, it picks a row directly — no
 * ambiguity is possible, since the caller already named an exact provider.
 * When absent, an LLM-kind id is resolved through the backend's
 * GET /strategy/models/:modelName/strategy (see resolveModelStrategy) rather
 * than a client-side guess: the backend is the single authority on whether a
 * bare model name has one answer, so its rejection (not a locally-recomputed
 * count) is what flips isAmbiguous — see the design doc's "Frontend
 * resolution flow" section for why this costs one extra request even for the
 * common (non-ambiguous) case.
 */
export function useStrategyMeta(
  strategyId: string | undefined,
  strategyQualifier?: string,
): UseStrategyMetaResult {
  const staticMeta = strategyId ? getStrategyMeta(strategyId) : undefined;
  const knownNonLlm = !!(staticMeta && staticMeta.kind !== "llm");
  const dynamicEnabled = !!strategyId && !knownNonLlm;

  const { data: models, loading: isResolvingModels } = useResource(
    ["supportedModels", strategyId],
    (signal) => fetchSupportedModels(signal),
    { enabled: dynamicEnabled },
  );

  // Only consulted when the URL named no explicit provider — a qualifier
  // already picks a single (strategyName, modelName) row directly below, so
  // there's nothing for the backend to resolve or reject.
  const { data: resolved, loading: isResolvingStrategy, error: resolveError } = useResource(
    ["resolveModelStrategy", strategyId],
    (signal) => resolveModelStrategy(strategyId as string, signal),
    { enabled: dynamicEnabled && !strategyQualifier },
  );

  const resolvedStrategyName = strategyQualifier ?? resolved?.strategyName;
  const match = models?.find(
    (model) => model.modelName === strategyId && model.strategyName === resolvedStrategyName,
  );
  const dynamicMeta = match ? buildDynamicMeta(match) : null;

  // The backend rejected an unqualified resolve — fall back to the
  // already-fetched bulk list to find out *why* and, if it's a real
  // collision, list the candidates. A rejection with 0 or 1 local matches
  // means the model genuinely doesn't exist / isn't supported (a stale
  // link), not an ambiguity — that falls through to the normal "Unknown
  // strategy" state via dynamicMeta staying null.
  const ambiguousCandidates =
    dynamicEnabled && !strategyQualifier && !!resolveError
      ? (models?.filter((model) => model.modelName === strategyId && model.supported) ?? [])
      : [];
  const isAmbiguous = ambiguousCandidates.length > 1;

  // For an LLM row, description always comes from live data once it
  // resolves (identity/copy — name/kind/strategyName — stays static); for
  // everything else the static entry is authoritative as-is.
  const meta =
    staticMeta && staticMeta.kind === "llm"
      ? dynamicMeta
        ? { ...staticMeta, description: dynamicMeta.description }
        : staticMeta
      : (staticMeta ?? dynamicMeta ?? undefined);

  return {
    meta,
    isResolving: isResolvingModels || isResolvingStrategy,
    isAmbiguous,
    ambiguousCandidates,
  };
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: errors at every call site that still calls `useStrategyMeta(strategyId)` expecting the old two-field return shape (`StrategyPuzzlePage.tsx`, `PuzzleRunsPage.tsx`) — this is expected; Tasks 5 and 7 fix those call sites. Confirm the *only* errors reported are in those two files (destructuring `meta`/`isResolving` still works since those fields are unchanged — new callers just don't need the new fields yet, so there should in fact be zero errors here; a nonzero, unrelated error means something else broke).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/data/benchmark/useStrategyMeta.ts
git commit -m "feat(frontend): make useStrategyMeta detect backend-confirmed model ambiguity"
```

---

### Task 4: Frontend — ambiguous-model picker widget

**Files:**
- Create: `frontend/src/components/benchmark/AmbiguousModelPicker.tsx`

**Interfaces:**
- Consumes: `ProviderPill` (existing, `frontend/src/components/benchmark/ProviderPill.tsx`), `SupportedModelRecord` type.
- Produces: `AmbiguousModelPicker({ modelName: string; candidates: SupportedModelRecord[] })` — a React component. Consumed by Task 5 and Task 7.

- [ ] **Step 1: Create the component**

```typescript
import { Link } from "react-router-dom";
import { ProviderPill } from "./ProviderPill";
import type { SupportedModelRecord } from "../../data/benchmark/types";

export interface AmbiguousModelPickerProps {
  modelName: string;
  candidates: SupportedModelRecord[];
}

/** Shown when a /leaderboard/:strategyId link names a model more than one
 * provider currently supports (see useStrategyMeta's isAmbiguous) and no
 * ?strategy= qualifier picked one — e.g. an old bookmark from before a
 * second provider started serving this model name. Each option carries the
 * same modelName forward with the qualifier added, reusing the leaderboard
 * table's own ProviderPill labels (see StrategyTable) so the choice reads
 * the same way the ambiguity was created. */
export function AmbiguousModelPicker({ modelName, candidates }: AmbiguousModelPickerProps) {
  return (
    <div className="bench-page">
      <p className="bench-muted">"{modelName}" is served by more than one provider. Pick one:</p>
      <div className="bench-badges">
        {candidates.map((candidate) => (
          <Link
            key={candidate.strategyName}
            to={`/leaderboard/${encodeURIComponent(modelName)}?strategy=${encodeURIComponent(candidate.strategyName)}`}
          >
            <ProviderPill strategyName={candidate.strategyName} />
          </Link>
        ))}
      </div>
      <Link to="/leaderboard" className="bench-page-header__back">
        ← Back to leaderboard
      </Link>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors from this file

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/benchmark/AmbiguousModelPicker.tsx
git commit -m "feat(frontend): add AmbiguousModelPicker widget"
```

---

### Task 5: Frontend — wire `StrategyPuzzlePage`

**Files:**
- Modify: `frontend/src/pages/benchmark/StrategyPuzzlePage.tsx`

**Interfaces:**
- Consumes: `useStrategyMeta` (Task 3, new 4-field return), `AmbiguousModelPicker` (Task 4), `RunHistoryTable`'s new `strategyQualifier` prop (Task 6 — write this task first if executing out of order, or accept a transient type error until Task 6 lands).

- [ ] **Step 1: Read the qualifier and branch on ambiguity**

In `frontend/src/pages/benchmark/StrategyPuzzlePage.tsx`:

Change the import on line 2 from:
```typescript
import { Link, useParams } from "react-router-dom";
```
to:
```typescript
import { Link, useParams, useSearchParams } from "react-router-dom";
```

Add an import for the picker, after the existing `BulkActionModal` import (line 4):
```typescript
import { AmbiguousModelPicker } from "../../components/benchmark/AmbiguousModelPicker";
```

Replace lines 42-47:
```typescript
export function StrategyPuzzlePage() {
  const { strategyId } = useParams();
  const { meta, isResolving: isResolvingMeta } = useStrategyMeta(strategyId);
  const resolvedStrategyName = meta?.strategyName;
  const resolvedKind = meta?.kind;
  const resolvedModelId = meta?.id;
```
with:
```typescript
export function StrategyPuzzlePage() {
  const { strategyId } = useParams();
  const [searchParams] = useSearchParams();
  const strategyQualifier = searchParams.get("strategy") ?? undefined;
  const {
    meta,
    isResolving: isResolvingMeta,
    isAmbiguous,
    ambiguousCandidates,
  } = useStrategyMeta(strategyId, strategyQualifier);
  const resolvedStrategyName = meta?.strategyName;
  const resolvedKind = meta?.kind;
  const resolvedModelId = meta?.id;
```

- [ ] **Step 2: Fix the leaderboard-row lookup to match strategyName too**

Replace lines 63-65:
```typescript
  const leaderboardRow = leaderboardData
    ? ([...leaderboardData.deterministic, ...leaderboardData.llm].find((r) => r.id === strategyId) ?? null)
    : null;
```
with:
```typescript
  // For an LLM row, id alone (bare modelName) isn't enough once a name is
  // shared by more than one provider — match strategyName too, now that
  // meta.strategyName has already been unambiguously resolved (either from
  // the ?strategy= qualifier or a unique backend match; the isAmbiguous
  // branch below returns before this point otherwise).
  const leaderboardRow =
    leaderboardData && meta
      ? ([...leaderboardData.deterministic, ...leaderboardData.llm].find(
          (r) => r.id === strategyId && (meta.kind !== "llm" || r.strategyName === meta.strategyName),
        ) ?? null)
      : null;
```

- [ ] **Step 3: Render the picker before the existing "unknown strategy" fallback**

Replace lines 125-134:
```typescript
  if (!strategyId) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown strategy.</p>
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Back to leaderboard
        </Link>
      </div>
    );
  }
```
with:
```typescript
  if (!strategyId) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown strategy.</p>
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Back to leaderboard
        </Link>
      </div>
    );
  }

  if (isAmbiguous) {
    return <AmbiguousModelPicker modelName={strategyId} candidates={ambiguousCandidates} />;
  }
```

- [ ] **Step 4: Pass the qualifier into `RunHistoryTable`**

In the `<RunHistoryTable ... />` call (currently lines 288-297), add the new prop:
```typescript
          <RunHistoryTable
            strategyId={strategyId}
            strategyQualifier={strategyQualifier}
            rows={history.rows}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            showTokenCost={resolvedKind === "llm"}
            status={status}
            onStatusChange={handleStatusChange}
          />
```

- [ ] **Step 5: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors once Task 6 (which adds the `strategyQualifier` prop to `RunHistoryTable`) is also done. If run before Task 6, the only expected error is `strategyQualifier` not existing on `RunHistoryTableProps` — do Task 6 next.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/benchmark/StrategyPuzzlePage.tsx
git commit -m "feat(frontend): show the ambiguous-model picker on StrategyPuzzlePage"
```

---

### Task 6: Frontend — carry the qualifier through `RunHistoryTable`'s puzzle links

**Files:**
- Modify: `frontend/src/components/benchmark/RunHistoryTable.tsx`

**Interfaces:**
- Produces: `RunHistoryTableProps` gains an optional `strategyQualifier?: string`. Consumed by Task 5 (already wired) and by `StrategyPuzzlePage`'s existing `strategyId` prop convention.

- [ ] **Step 1: Add the prop and use it in both navigate() calls**

In `frontend/src/components/benchmark/RunHistoryTable.tsx`, update the props interface (lines 21-43) — add after `strategyId` (line 28):
```typescript
  strategyId: string;
  /** The page's ?strategy= qualifier, when the model name it's viewing is
   * ambiguous (see useStrategyMeta) — carried into the puzzle-detail link so
   * PuzzleRunsPage resolves the same provider without re-showing the picker. */
  strategyQualifier?: string;
  rows: RunHistoryRow[];
```

Update the function signature (lines 63-72) to destructure it:
```typescript
export function RunHistoryTable({
  strategyId,
  strategyQualifier,
  rows,
  sortBy,
  sortDir,
  onSortChange,
  showTokenCost,
  status,
  onStatusChange,
}: RunHistoryTableProps) {
  const navigate = useNavigate();
  const qualifierSuffix = strategyQualifier ? `?strategy=${encodeURIComponent(strategyQualifier)}` : "";
```

Replace both `navigate(...)` calls (currently lines 104 and 108):
```typescript
            onClick={() => navigate(`/leaderboard/${encodeURIComponent(strategyId)}/${row.puzzleId}${qualifierSuffix}`)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                navigate(`/leaderboard/${encodeURIComponent(strategyId)}/${row.puzzleId}${qualifierSuffix}`);
              }
            }}
```

- [ ] **Step 2: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/benchmark/RunHistoryTable.tsx
git commit -m "feat(frontend): carry the ?strategy= qualifier into RunHistoryTable's puzzle links"
```

---

### Task 7: Frontend — wire `PuzzleRunsPage`

**Files:**
- Modify: `frontend/src/pages/benchmark/PuzzleRunsPage.tsx`

**Interfaces:**
- Consumes: `useStrategyMeta` (Task 3), `AmbiguousModelPicker` (Task 4).

- [ ] **Step 1: Read the qualifier and branch on ambiguity**

Change the import on line 2 from:
```typescript
import { Link, useParams } from "react-router-dom";
```
to:
```typescript
import { Link, useParams, useSearchParams } from "react-router-dom";
```

Add an import for the picker, after the `GuessChainVisualizer` import (line 3):
```typescript
import { AmbiguousModelPicker } from "../../components/benchmark/AmbiguousModelPicker";
```

Replace lines 52-63:
```typescript
export function PuzzleRunsPage() {
  const { strategyId, puzzleId: puzzleIdParam } = useParams();
  const puzzleId = Number(puzzleIdParam);
  const isValidPuzzleId = Number.isInteger(puzzleId);

  const { meta, isResolving: isResolvingMeta } = useStrategyMeta(strategyId);
  // Stable primitives (not `meta` itself — a fresh object every render for
  // the static-lookup case) so effects below can depend on "is this strategy
  // resolved" without re-firing on every render.
  const resolvedStrategyName = meta?.strategyName;
  const resolvedKind = meta?.kind;
  const resolvedModelId = meta?.id;
```
with:
```typescript
export function PuzzleRunsPage() {
  const { strategyId, puzzleId: puzzleIdParam } = useParams();
  const puzzleId = Number(puzzleIdParam);
  const isValidPuzzleId = Number.isInteger(puzzleId);
  const [searchParams] = useSearchParams();
  const strategyQualifier = searchParams.get("strategy") ?? undefined;
  const qualifierSuffix = strategyQualifier ? `?strategy=${encodeURIComponent(strategyQualifier)}` : "";

  const {
    meta,
    isResolving: isResolvingMeta,
    isAmbiguous,
    ambiguousCandidates,
  } = useStrategyMeta(strategyId, strategyQualifier);
  // Stable primitives (not `meta` itself — a fresh object every render for
  // the static-lookup case) so effects below can depend on "is this strategy
  // resolved" without re-firing on every render.
  const resolvedStrategyName = meta?.strategyName;
  const resolvedKind = meta?.kind;
  const resolvedModelId = meta?.id;
```

- [ ] **Step 2: Render the picker before the existing "unknown strategy" fallback**

Replace lines 94-103:
```typescript
  if (!strategyId) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown strategy.</p>
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Back to leaderboard
        </Link>
      </div>
    );
  }
```
with:
```typescript
  if (!strategyId) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown strategy.</p>
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Back to leaderboard
        </Link>
      </div>
    );
  }

  if (isAmbiguous) {
    return <AmbiguousModelPicker modelName={strategyId} candidates={ambiguousCandidates} />;
  }
```

- [ ] **Step 3: Carry the qualifier on both back-links**

Replace line 127:
```typescript
        <Link to={`/leaderboard/${encodeURIComponent(strategyId)}`} className="bench-page-header__back">
```
with:
```typescript
        <Link to={`/leaderboard/${encodeURIComponent(strategyId)}${qualifierSuffix}`} className="bench-page-header__back">
```

Replace line 138:
```typescript
          <Link to={`/leaderboard/${encodeURIComponent(strategyId)}`} className="bench-page-header__back">
```
with:
```typescript
          <Link to={`/leaderboard/${encodeURIComponent(strategyId)}${qualifierSuffix}`} className="bench-page-header__back">
```

- [ ] **Step 4: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/benchmark/PuzzleRunsPage.tsx
git commit -m "feat(frontend): show the ambiguous-model picker on PuzzleRunsPage"
```

---

### Task 8: Frontend — qualify ambiguous row-clicks in `StrategyTable`, fix the React key collision

**Files:**
- Modify: `frontend/src/components/benchmark/StrategyTable.tsx`

**Interfaces:**
- No new exports — internal to the component's render/click logic.

- [ ] **Step 1: Compute which model names are ambiguous, from this table's own rows**

In `frontend/src/components/benchmark/StrategyTable.tsx`, after the existing `sorted`/`isDeterministic` setup (lines 87-91), add:

```typescript
  const sorted = sortLeaderboardRows(rowsWithMeta, sortBy, sortDir);
  const isDeterministic = variant === "deterministic";

  // A model name shared by more than one provider's row needs its
  // strategyName carried explicitly (see useStrategyMeta) — every other
  // row's URL stays exactly as it is today. Computed live from this table's
  // own rows (not a hardcoded list), so a future provider colliding with an
  // existing model name needs no code change here — only its SupportedModel
  // seed rows.
  const modelNameCounts = new Map<string, number>();
  if (variant === "llm") {
    for (const row of rows) {
      modelNameCounts.set(row.id, (modelNameCounts.get(row.id) ?? 0) + 1);
    }
  }

  function linkFor(row: LeaderboardRow): string {
    const isAmbiguous = (modelNameCounts.get(row.id) ?? 0) > 1;
    const qualifier = isAmbiguous ? `?strategy=${encodeURIComponent(row.strategyName)}` : "";
    return `/leaderboard/${encodeURIComponent(row.id)}${qualifier}`;
  }

```

(This replaces the original two-line block — keep `captionId`/`gridClass` below it unchanged.)

- [ ] **Step 2: Use `linkFor` in the click handlers, and fix the row `key`**

Replace lines 189-201:
```typescript
            <div
              key={row.id}
              className={`bench-grid-row ${gridClass} ${index === 0 ? "bench-row bench-row--leading" : "bench-row"}`}
              onClick={() => navigate(`/leaderboard/${encodeURIComponent(row.id)}`)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(`/leaderboard/${encodeURIComponent(row.id)}`);
                }
              }}
              role="link"
              tabIndex={0}
              aria-label={`View ${name} details`}
            >
```
with:
```typescript
            <div
              // row.id alone isn't a unique React key once two rows (one per
              // provider) can share the same modelName — strategyName makes
              // it unique again without needing to be parsed back out of
              // anywhere, unlike the URL (see linkFor above).
              key={`${row.strategyName}::${row.id}`}
              className={`bench-grid-row ${gridClass} ${index === 0 ? "bench-row bench-row--leading" : "bench-row"}`}
              onClick={() => navigate(linkFor(row))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  navigate(linkFor(row));
                }
              }}
              role="link"
              tabIndex={0}
              aria-label={`View ${name} details`}
            >
```

- [ ] **Step 3: Type-check**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Manual verification**

Run: `cd frontend && npm run dev` (with the backend running and NVIDIA's migration applied, per the current branch's state).
- Open `/leaderboard`. Confirm the LLM table shows two distinct rows both labeled `openai/gpt-oss-20b`, one tagged "Groq", one tagged "NVIDIA NIM" (existing `ProviderPill` behavior — unchanged).
- Click the Groq row: confirm the URL is `/leaderboard/openai%2Fgpt-oss-20b?strategy=llm-groq` and the page shows Groq's run history/summary stats.
- Click the NVIDIA row: confirm the URL is `/leaderboard/openai%2Fgpt-oss-20b?strategy=llm-nvidia` and the page shows NVIDIA's run history/summary stats (different from Groq's).
- Manually navigate to `/leaderboard/openai%2Fgpt-oss-20b` (no query string): confirm the picker renders with two options, and each option navigates to the correct qualified page.
- Click any *other* (non-colliding) LLM row, e.g. a `gpt-5.4` row: confirm its URL is still the plain `/leaderboard/gpt-5.4` with no `?strategy=` — no behavior change.
- From a qualified detail page, click into a puzzle row's run history, then click "back": confirm the qualifier survives the round trip and you land back on the same provider's page, not the picker.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/benchmark/StrategyTable.tsx
git commit -m "fix(frontend): qualify ambiguous leaderboard row links, fix duplicate React key"
```

---

## Self-Review

**Spec coverage:**
- Decision 1 (fix on this branch) — this plan's commits land directly on the current branch; no task splits work elsewhere. ✓
- Decision 2 (tiebreaker-only) — Task 8's `modelNameCounts` only special-cases duplicated names; Tasks 3/5/7's qualifier logic is a no-op (empty/absent) for unique models. ✓
- Decision 3 (admin routes untouched) — no task touches `dispatch.controller.ts`. ✓
- Decision 4 (reuse existing labels) — Task 4's picker uses `ProviderPill` directly, no new label scheme. ✓
- Decisions 5/8/routing correction (`?strategy=` query param, not a path segment) — Tasks 5-8 all use `?strategy=`; no `App.tsx` route changes anywhere in this plan. ✓
- Decision 6 (backend enforces) — Task 1 adds the endpoint; Task 3 is the only caller and treats its rejection as authoritative. ✓
- Decision 7 (simple inline widget) — Task 4. ✓
- Decision 9 (only ambiguous rows qualified, computed live) — Task 8's `modelNameCounts`. ✓
- The three original break points from the spec's Problem section: `resolveSupportedStrategy` (unchanged, Decision 3), `strategy-read.service.ts:562` (left as-is per Decision 2 — no task touches it), `useStrategyMeta`/`StrategyPuzzlePage`'s `.find()`s (Task 3 and Task 5 Step 2). ✓

**Placeholder scan:** No TBD/TODO markers; every step has complete code, not a description of code.

**Type consistency:** `useStrategyMeta`'s new return shape (`meta`, `isResolving`, `isAmbiguous`, `ambiguousCandidates`) is defined once in Task 3 and consumed identically in Tasks 5 and 7. `RunHistoryTableProps.strategyQualifier` is defined in Task 6 and used identically in Task 5. `AmbiguousModelPickerProps` is defined in Task 4 and used identically in Tasks 5 and 7. `resolveModelStrategy`/`ResolvedModelStrategy` defined in Task 2, consumed only in Task 3.
