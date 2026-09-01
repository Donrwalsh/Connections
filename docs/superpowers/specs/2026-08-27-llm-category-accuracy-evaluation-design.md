# LLM category-accuracy evaluation — design

## Problem

The benchmark already records, for every LLM solve step, each candidate
group the model proposed
([`LlmProposal`](../../../backend/src/modules/strategy/entities/llm-proposal.entity.ts)),
which proposal was actually submitted as a guess
(`status = 'used'`, linked to a `Guess`), and whether that guess was
correct (`Guess.result`). What it does **not** record is whether a
*correct* guess was correct for the *right reason*.

Each proposal carries a free-text `category` — the model's own label for
why those four words belong together ("types of fish", "\_\_\_ FISH",
"things that are slippery"). The puzzle itself carries the real label on
the matching
[`AnswerGroup.group_name`](../../../backend/src/modules/game/entities/answer-group.entity.ts).
Today those two strings are never compared. A model that guesses the four
right words while completely misreading the connection scores identically
to one that nailed the theme. There is no way to tell a genuinely strong
category-reasoner from a lucky guesser, and no way to compare that quality
across models on the leaderboard.

## Goals

- For every proposal that was **used as a guess and that guess succeeded**,
  produce a stored verdict on whether the model's proposed `category`
  captures the same connection as the puzzle's real `group_name`:
  `correct`, `partial`, or `lucky`.
- The comparison is semantic, done by an LLM judge (Connections categories
  are wordplay-heavy and rarely match literally), reached through the
  existing orchestrator service that already owns every model call.
- Each verdict row stores full judge-call diagnostics — model, request
  body, response headers/body, raw text, token usage, latency, errors —
  modeled on the diagnostic fields already on
  [`SolvePrompt`](../../../backend/src/modules/strategy/entities/solve-prompt.entity.ts),
  so a specific verdict can be audited and troubleshooted.
- Evaluation runs as its own BullMQ jobs on the judge provider's existing
  LLM queue (one job per proposal), kicked off by a password-protected
  backend endpoint that enqueues the latest un-evaluated successful
  proposals.
- Surface category accuracy on the leaderboard: a display column and a
  sortable metric on the LLM table, a correct/partial/lucky breakdown on
  the per-model detail page, and a per-proposal verdict (with the judge
  diagnostics) in the guess-chain view.

## Non-goals

- **No evaluation of unsuccessful guesses, or of proposals that were never
  used.** The question being asked — "when the model got the words right,
  did it also get the connection right" — only applies to used proposals
  whose guess succeeded. Evaluating near-misses is a separate idea.
- **No inline evaluation during a solve run in this change.** The evaluator
  service method is shaped so a future change can call it straight from
  [`llm-strategy-runner.service.ts`](../../../backend/src/modules/strategy/llm-strategy-runner.service.ts)
  right after a proposal is marked `used` and its guess resolves, but this
  change only wires the batch/queue path.
- **No embedding or lexical similarity fallback.** The judge is the only
  comparison mechanism. If judge cost or latency ever justifies a cheaper
  pre-filter, that is a later addition.
- **No re-judging UI or scheduled re-evaluation.** Re-running is a manual
  `--force` on the CLI script (or deleting rows and re-enqueuing). An
  `evaluatorVersion` integer is stored so a future re-judge pass can find
  rows produced by an older judge prompt, but nothing acts on it yet.
- **No new judge concurrency/rate limiting.** Jobs ride the judge
  provider's existing LLM queue and worker, so they inherit that
  provider's concurrency and naturally interleave with its solve runs —
  which is wanted, since both hit the same provider API under the same
  limits.
- **No image-puzzle special-casing.** If a successful guess's word set
  cannot be matched to an `AnswerGroup` (the plausible failure mode is an
  image puzzle whose `Guess.words` are not the group's stored member
  words), that proposal is skipped and logged, not force-matched.

## Design

### 1. `CategoryEvaluation` entity and migration

New entity
`backend/src/modules/strategy/entities/category-evaluation.entity.ts`,
table `CategoryEvaluation`, one row per judged proposal.

**Linkage**

| column | type | notes |
| --- | --- | --- |
| `id` | `PrimaryGeneratedColumn` | |
| `llmProposalId` | `int`, FK → `LlmProposal`, `onDelete: CASCADE`, **unique** | one evaluation per proposal; a re-judge overwrites the row rather than adding a second |
| `strategyRunId` | `int`, FK → `StrategyRun`, `onDelete: CASCADE`, indexed | denormalized so the leaderboard aggregate groups by it without a three-table join — mirrors how `LlmProposal` itself carries `strategyRunId` alongside `solvePromptId` |
| `answerGroupId` | `int`, FK → `AnswerGroup`, `onDelete: CASCADE` | the real group whose word set matched the winning guess |

**Verdict**

| column | type | notes |
| --- | --- | --- |
| `verdict` | `enum category_eval_verdict_enum` (`correct` \| `partial` \| `lucky`), **nullable** | `null` on a `callError` row |
| `rationale` | `text`, nullable | the judge's one-sentence explanation |
| `proposedCategory` | `text` | snapshot of `LlmProposal.category` at evaluation time |
| `actualCategory` | `text` | snapshot of `AnswerGroup.group_name` at evaluation time |
| `status` | `enum category_eval_status_enum` (`judged` \| `callError`), default `judged` | mirrors the outcome split `SolvePromptStatus` makes — did the judge call produce a usable verdict at all |
| `evaluatorVersion` | `int`, `NOT NULL` | bumped in code when the judge prompt template changes materially, so a later pass can identify stale rows; nothing reads it yet |

**Judge-call diagnostics** — the same shape as `SolvePrompt`'s raw call
detail
([`solve-prompt.entity.ts:106-148`](../../../backend/src/modules/strategy/entities/solve-prompt.entity.ts#L106-L148)):

`judgeModel text`, `judgeProvider text` (`openai` \| `ollama` \| `google`),
`requestBody jsonb null`, `responseId text null`,
`responseHeaders jsonb null`, `responseBody jsonb null`,
`rawResponseText text null` (the judge's raw output before the structured
verdict is parsed), `statusCode int null`, `errorName text null`,
`errorMessage text null`, `isRetryable boolean null`,
`promptTokens int null`, `completionTokens int null`,
`totalTokens int null`, `latencyMs int null`,
`temperature double precision null`,
`evaluatedAt timestamptz` (`@CreateDateColumn`).

`judgeModel` is always set, even on a failed call (resolved from
config before the call, the way
[`getModelName`](../../../orchestrator/src/provider.ts) is used on the
orchestrator side), so every row names the model it used.

**Migration** `backend/src/migrations/<ts>-add-category-evaluation.ts`,
following the existing migration style (raw `query()` calls, explicit
`up`/`down`):

1. `CREATE TYPE "category_eval_verdict_enum" AS ENUM ('correct', 'partial', 'lucky')`
2. `CREATE TYPE "category_eval_status_enum" AS ENUM ('judged', 'callError')`
3. `CREATE TABLE "CategoryEvaluation" (...)` with the columns above, the
   FKs, `UNIQUE ("llmProposalId")`, and
   `CREATE INDEX "IDX_CategoryEvaluation_strategyRunId" ON "CategoryEvaluation" ("strategyRunId")`.

`down()` drops the table then both types. No data backfill in the
migration — rows are produced entirely by the evaluation jobs.

The entity is registered in
[`TypeOrmModule.forFeature`](../../../backend/src/modules/strategy/strategy.module.ts#L20)
and added to the `data-source.ts` entity list.

### 2. Which proposals are evaluated, and matching the real category

**Population.** A proposal is in scope when
`LlmProposal.status = 'used'` **and** its linked `Guess.result = 'success'`.
This is exactly the "used as a guess and the guess was true" set.

**Matching to the real category.** The used proposal links to its `Guess`;
`Guess.words` is the four-word winning set, and `Guess.puzzleId` gives the
puzzle. Load that puzzle with `answerGroups.members` (the relation
[`StrategyRunStore.loadOrCreateRun`](../../../backend/src/modules/strategy/strategy-run-store.service.ts)
already uses) and find the single `AnswerGroup` whose member `word` set
equals the guess's word set, order-independent (compare sorted arrays or
`Set`s). Because the guess succeeded, exactly one group matches by
construction.

If no group matches — a data anomaly, or an image puzzle whose
`Guess.words` are not the stored member words — the proposal is skipped
with a warning log and no row is written. It will simply be picked up
again on the next enqueue (still un-evaluated); if it can never match,
it stays skipped harmlessly.

`proposedCategory` and `actualCategory` are snapshotted onto the row from
`LlmProposal.category` and the matched `AnswerGroup.group_name` so a
later edit to either source doesn't silently change what a stored verdict
was about.

### 3. Orchestrator `POST /judge-category`

A new endpoint on the orchestrator
([`orchestrator/src/app.ts`](../../../orchestrator/src/app.ts)), alongside
`/solve-assist`, behind the same `x-internal-api-key` middleware and a
`bodyLimit`.

**Request body** (validated with a new zod schema in
[`orchestrator/src/types.ts`](../../../orchestrator/src/types.ts)):

```
{
  proposedCategory: string,
  actualCategory: string,
  model?: string,
  provider?: "openai" | "ollama" | "google"
}
```

Categories only — the four words are deliberately **not** sent. The judge
is grading whether one label expresses the same connection as another
label, and both labels already describe the same items by construction.

**Implementation** — new `orchestrator/src/judge-category.ts`, structured
like `solve-assist.ts`:

- Resolve provider/model via
  [`provider.ts`](../../../orchestrator/src/provider.ts) (`model` /
  `provider` override the env default, same as `solveAssist`).
- Call the AI SDK's `generateObject` with the schema
  `{ verdict: z.enum(["correct", "partial", "lucky"]), rationale: z.string() }`
  and `temperature: 0`.
- Capture `result.request.body`, `result.response.{id, headers, body}`,
  `result.usage`, latency, and the raw text (`result.text` when the SDK
  exposes it for object mode, else `JSON.stringify(result.object)`) — the
  same fields `solveAssist` returns.
- On a thrown model-call error, reuse
  [`classifyModelCallError`](../../../orchestrator/src/solver.ts) so the
  failure carries `model`, `latencyMs`, and whatever request/response
  detail was captured, exactly like the solve path.

**Response** — the `SolveAssistSuccess`-shaped envelope plus the verdict:

```
{
  verdict: "correct" | "partial" | "lucky",
  rationale: string,
  model: string,
  latencyMs: number,
  usage?: { promptTokens, completionTokens, totalTokens },
  requestBody?, responseId?, responseHeaders?, responseBody?
}
```

**Prompt** — a single user message. Example, rendered for one call:

```
You are grading whether a puzzle solver correctly identified the theme
connecting a group of four items.

The solver labeled the group:
  "Fruits"

The puzzle's real label for that group is:
  "___ COBBLER"

Both labels describe the same four items. Decide whether the solver
understood the actual connection:

- correct: the solver's label expresses the same connection as the real
  label, even if worded differently.
- partial: the solver's label is related or thematically close, but
  misses, over-generalizes, or garbles the specific connection.
- lucky: the solver's label does not reflect the real connection - a
  right group of items for the wrong reason, or for no clear reason.

Respond with JSON: {"verdict": "correct"|"partial"|"lucky",
"rationale": "<one sentence>"}
```

For this example the judge should return `partial` — the solver saw the
items are fruits but missed that the connection is words that precede
"cobbler". The closing "Respond with JSON" line is redundant with
`generateObject`'s schema enforcement but kept as a guard and to keep the
prompt legible on its own.

**Configuration** — two new env vars, read on the orchestrator side by
`provider.ts`-style helpers and mirrored into
[`backend/src/config/env.ts`](../../../backend/src/config/env.ts)'s
`AppEnv` for the backend request:

- `JUDGE_MODEL` — default `gpt-4.1-nano`
- `JUDGE_PROVIDER` — default `openai`

Neither is required to boot; both default. Added to `.env.sample`.

**Backend client** — `OrchestratorService` gains `judgeCategory(...)`
mirroring
[`solveAssist(...)`](../../../backend/src/modules/strategy/orchestrator.service.ts#L80):
it POSTs to `/judge-category` through the existing `executeCall`
plumbing and maps the same detail fields onto its outcome. A failed or
malformed judge call comes back as the existing
`{ ok: false, error: SolveAssistFailure }` shape.

### 4. Queue wiring, job, worker, endpoint, service

#### 4a. Finish the `llm-google` queue wiring

The worker already starts an `llm-google-runs` consumer
([`worker.ts:185-191`](../../../backend/src/worker.ts#L185-L191)), but the
producer half was never added: there is no `llmGoogleQueue`,
[`queue.module.ts`](../../../backend/src/modules/queue/queue.module.ts)
has no `LLM_GOOGLE_QUEUE` provider, and
[`queueForStrategy`](../../../backend/src/modules/queue/strategy.queue.ts#L48)
does not route `llm-google` (it falls through to the shared
`strategy-runs` queue). This change adds:

- `llmGoogleQueue = new Queue("llm-google-runs", ...)` in
  [`strategy.queue.ts`](../../../backend/src/modules/queue/strategy.queue.ts),
  same `defaultJobOptions` as the other two LLM queues.
- `LLM_GOOGLE_QUEUE` token + provider + export in `queue.module.ts`.
- `queueForStrategy` returns it for `LLM_GOOGLE`.
- The Bull-Board adapter list in
  [`app.setup.ts:193-195`](../../../backend/src/app.setup.ts#L193-L195)
  gains `llmGoogleQueue`.

This is needed because the judge provider is configurable and `google` is
a first-class option; it also closes the existing gap for actual
`llm-google` solve runs. With the default `JUDGE_PROVIDER=openai` the
judge path uses the already-wired `llm-openai-runs` queue.

#### 4b. The evaluation job

One BullMQ job **per proposal**:

- **queue**: the judge provider's LLM queue — `openai` → `llm-openai-runs`,
  `google` → `llm-google-runs`, `ollama` → `llm-ollama-runs`. A small
  `queueForJudgeProvider(provider)` helper next to `queueForStrategy`.
- **name**: `"evaluate-category"` (the existing jobs use `"run-strategy"`).
- **data**: `{ llmProposalId: number }`.
- **jobId**: `cat-eval-<llmProposalId>` — deterministic, so a duplicate
  enqueue while one is still pending collapses to a single job, the same
  pattern
  [`runStrategyJobId`](../../../backend/src/modules/queue/strategy.queue.ts#L63)
  uses.

Riding the provider's own queue means evaluation jobs share that
provider's worker concurrency and interleave with its solve runs, under
the same upstream rate limits — intended.

#### 4c. Worker branch

[`createLlmWorker`](../../../backend/src/worker.ts#L115)'s handler is the
single processor for all three provider queues. It gains a branch at the
top on `job.name`:

- `"evaluate-category"` → `categoryEvaluatorService.evaluateProposal(job.data.llmProposalId)`
- anything else → the existing `runLlmStrategy(...)` path unchanged

`CategoryEvaluatorService` is resolved from the app context in
`bootstrap()` alongside the other services. The `expectedStrategy`
mismatch guard currently at the top of the handler moves inside the
non-evaluate branch (an evaluate job has no strategy).

#### 4d. Password-protected endpoint

`POST /dispatch/evaluate-categories` on
[`DispatchController`](../../../backend/src/modules/dispatch/dispatch.controller.ts),
`@UseGuards(DispatchAuthGuard)` + `@ApiBody({ type: DispatchAuthDto })` —
the same production-only password gate every other paid-call dispatch
route uses.

- Optional `?limit` query, default `50`, clamped to `1..500`.
- Body: `{ password? }` (the `DispatchAuthDto`).
- Delegates to `CategoryEvaluatorService.enqueuePending({ limit })`.
- Returns `{ enqueued: number, llmProposalIds: number[] }`.

#### 4e. `CategoryEvaluatorService`

New `backend/src/modules/strategy/category-evaluator.service.ts`,
registered in `StrategyModule` `providers`, injecting (explicit
`@Inject(...)` per this backend's DI convention — see
[memory note](../../../backend/src/modules/strategy/strategy.service.ts#L171))
the `CategoryEvaluation`, `LlmProposal`, `Guess`, `Puzzle` repos, the
three LLM queue tokens, and `OrchestratorService`.

- **`enqueuePending({ limit }): Promise<{ enqueued, llmProposalIds }>`** —
  selects `LlmProposal` rows where `status = 'used'`, joined to a `Guess`
  with `result = 'success'`, `LEFT JOIN "CategoryEvaluation"` with the
  join key `llmProposalId` and `WHERE "CategoryEvaluation"."id" IS NULL`,
  `ORDER BY "LlmProposal"."id" DESC`, `LIMIT :limit` — "the latest
  un-evaluated successful solves". For each, `add(...)` one job (4b) to
  the judge provider's queue. Returns the count and ids.

- **`evaluateProposal(llmProposalId, { force = false } = {})`** —
  the worker-side unit of work:
  1. Load the proposal with its `guess`. If missing, or not
     `used`/`success`, log and return (a stale job).
  2. If a `CategoryEvaluation` row already exists for it and not `force`,
     return (idempotent — safe for BullMQ retries and duplicate enqueues).
  3. Match the winning word set to an `AnswerGroup` (§2). No match → warn
     and return without writing.
  4. `orchestrator.judgeCategory(proposedCategory, actualCategory,
     JUDGE_MODEL, JUDGE_PROVIDER)`.
  5. Write **one** `CategoryEvaluation` row (upsert on the unique
     `llmProposalId` when `force`):
     - success → `status: 'judged'`, `verdict`, `rationale`,
       `proposedCategory`, `actualCategory`, `answerGroupId`,
       `evaluatorVersion` (a module constant), and every diagnostic field
       from the orchestrator outcome.
     - failure → `status: 'callError'`, `verdict: null`, the snapshot
       categories + `answerGroupId`, and `errorName` / `errorMessage` /
       `statusCode` / `isRetryable` / `requestBody` / `responseBody` /
       `responseHeaders` from the failure.
  A `callError` does **not** re-throw — the row is the record of the
  attempt, mirroring how the solve runner persists a failed call as its
  own `SolvePrompt` rather than bubbling it
  ([`orchestrator.service.ts:104-110`](../../../backend/src/modules/strategy/orchestrator.service.ts#L104-L110)).

- **`EVALUATOR_VERSION`** — a module-level `const` (starts at `1`), stored
  on every row; bumped only when the prompt in §3 changes meaningfully.

#### 4f. CLI script

`backend/src/scripts/evaluate-categories.ts`, patterned on
[`backfill-issue-tags.ts`](../../../backend/src/scripts/backfill-issue-tags.ts)
(`NestFactory.createApplicationContext`, resolve the service, run,
explicit `process.exit`). It calls the same `enqueuePending` — it is an
enqueue path, not an inline runner, so the worker still does the judging.
`--limit N` supported; `--force` re-enqueues even already-evaluated
proposals (the job then passes `force` through). npm script
`eval:categories`.

#### 4g. Future inline hook (not built here)

`evaluateProposal` takes a bare `llmProposalId` and makes no batch
assumptions, so a later change can, right after
[`llm-strategy-runner.service.ts:540-541`](../../../backend/src/modules/strategy/llm-strategy-runner.service.ts#L540-L541)
marks a proposal `used` and its guess resolves `success`, enqueue a
`cat-eval-<id>` job (or call the service directly). Out of scope now.

### 5. Leaderboard aggregation

[`getLeaderboard`](../../../backend/src/modules/strategy/strategy.service.ts#L459)
already fans out its reads through one `Promise.all` and aggregates in JS.
Add one more query to that array — a fresh `CategoryEvaluation` repo is
injected into `StrategyService`, so this is a new `createQueryBuilder`
call on a **different** repo and carries none of the mock-reuse hazard the
[`avgIssues` design](2026-08-27-leaderboard-avg-issues-design.md) had to
work around:

```sql
SELECT
  ce."strategyRunId"                                          AS "strategyRunId",
  COUNT(*) FILTER (WHERE ce."verdict" = 'correct')::int       AS "correct",
  COUNT(*) FILTER (WHERE ce."verdict" = 'partial')::int       AS "partial",
  COUNT(*) FILTER (WHERE ce."verdict" = 'lucky')::int         AS "lucky"
FROM "CategoryEvaluation" ce
GROUP BY ce."strategyRunId"
```

A `callError` row has `verdict = null` and is counted in none of the
three buckets, so judge failures never move the accuracy number — the
same choice `issueCount` makes for call errors.

`LeaderboardAccumulator`
([`strategy.service.ts:123-158`](../../../backend/src/modules/strategy/strategy.service.ts#L123))
gains `catCorrect: number`, `catPartial: number`, `catLucky: number`,
initialized to `0` and summed per `(strategyName, modelName)` inside the
existing `for (const run of runs)` loop, keyed by
`categoryCountsByRun.get(run.id)`. No status gating — an evaluation
belongs to whichever run its proposal belongs to, regardless of that
run's own status.

New fields on
[`LeaderboardRowDto`](../../../backend/src/modules/strategy/dto/strategy.dto.ts#L126):

```typescript
// Category-reasoning quality for this model's successful guesses, from the
// LLM judge (see 2026-08-27-llm-category-accuracy-evaluation-design.md).
// correct/partial/lucky are raw verdict counts across every successful
// used proposal of this model that has been evaluated; categoryEvaluated
// is their sum. categoryAccuracy is correct / categoryEvaluated * 100, or
// null when categoryEvaluated is 0 — which is also the case for every
// deterministic/shuffle row (no proposals, no evaluations), so those show
// "—" the same way avgCostUsd/avgIssues already do.
categoryCorrect: number;
categoryPartial: number;
categoryLucky: number;
categoryEvaluated: number;
categoryAccuracy: number | null;
```

Computed in the row map next to `avgIssues`:

```typescript
const categoryEvaluated = acc.catCorrect + acc.catPartial + acc.catLucky;
// ...
categoryCorrect: acc.catCorrect,
categoryPartial: acc.catPartial,
categoryLucky: acc.catLucky,
categoryEvaluated,
categoryAccuracy: categoryEvaluated === 0 ? null : (acc.catCorrect / categoryEvaluated) * 100,
```

The 15-second `LEADERBOARD_CACHE_TTL_MS` cache already in `getLeaderboard`
covers this with no change.

### 6. Frontend

#### 6a. Row type

[`frontend/src/data/benchmark/types.ts`](../../../frontend/src/data/benchmark/types.ts)'s
`LeaderboardRow` gains the five fields from §5, raw-JSON passthrough (no
remap in `api.ts`), the same contract as every other `LeaderboardRow`
field.

#### 6b. LLM leaderboard column — "Category IQ"

[`StrategyTable.tsx`](../../../frontend/src/components/benchmark/StrategyTable.tsx),
`variant === 'llm'` only. A new column header **"Category IQ"** after
"Avg issues", and a cell:

```tsx
<td
  className="bench-mono"
  title={
    row.categoryEvaluated === 0
      ? "No successful guesses evaluated yet"
      : `${row.categoryCorrect} of ${row.categoryEvaluated} correct · ${row.categoryPartial} partial · ${row.categoryLucky} lucky`
  }
>
  {row.categoryAccuracy === null ? "—" : formatSuccessRate(row.categoryAccuracy)}
</td>
```

`formatSuccessRate` is reused as-is (it already renders a 0–100 number to
3 significant figures with a `%`). The deterministic/shuffle table is
untouched — no header, no cell — the same way it already skips "Avg
issues".

#### 6c. Sortable metric

[`metrics.ts`](../../../frontend/src/data/benchmark/metrics.ts):

- `LeaderboardMetricKey` gains `"categoryAccuracy"`.
- A `LEADERBOARD_METRICS` entry: `key: "categoryAccuracy"`,
  `label: "Category IQ"`,
  `description: "Share of evaluated successful guesses where the model named the real connection"`,
  `higherIsBetter: true`,
  `format: (v) => formatSuccessRate(v)`.
- `MetricSource` gains `categoryAccuracy: number | null`.
- `metricValue` gains the `case "categoryAccuracy": return strategy.categoryAccuracy;`.

`sortStrategiesByMetric` already sends `null` to the bottom, so a model
with no evaluations sorts last on this metric.
[`MetricSelector`](../../../frontend/src/components/benchmark/MetricSelector.tsx)
renders the new option from `LEADERBOARD_METRICS` with no change.

#### 6d. Per-model detail page breakdown

[`StrategyPuzzlePage.tsx`](../../../frontend/src/pages/benchmark/StrategyPuzzlePage.tsx)
(route `/leaderboard/:id`) renders the aggregate row it already fetches.
Add a small block near the existing success-rate summary:

> **Category IQ** — `formatSuccessRate(categoryAccuracy)` (or "not yet
> evaluated" when `categoryEvaluated === 0`), with the raw split beneath:
> `{correct} correct · {partial} partial · {lucky} lucky` out of
> `{categoryEvaluated}` evaluated.

No new endpoint — the counts are already on the leaderboard row. The
per-proposal detail (which specific categories the model got wrong, and
why) lives in the guess chain, §6e.

#### 6e. Guess-chain view

[`LlmProposalDto`](../../../backend/src/modules/strategy/dto/strategy.dto.ts#L28)
gains `categoryEvaluation: CategoryEvaluationDto | null`, populated in
[`buildSolvePromptDtos`](../../../backend/src/modules/strategy/strategy.service.ts#L816):
its `Promise.all` gains a `categoryEvaluationRepo.find({ where: { strategyRunId: run.id } })`,
and each proposal DTO gets its matching row attached by `llmProposalId`
(most proposals have none).

`CategoryEvaluationDto`:

```typescript
export interface CategoryEvaluationDto {
  verdict: "correct" | "partial" | "lucky" | null;
  status: "judged" | "callError";
  proposedCategory: string;
  actualCategory: string;
  rationale: string | null;
  judgeModel: string;
  judgeProvider: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  statusCode: number | null;
  errorName: string | null;
  errorMessage: string | null;
  requestBody: unknown | null;
  responseHeaders: Record<string, string> | null;
  responseBody: unknown | null;
  rawResponseText: string | null;
  evaluatedAt: Date;
}
```

`frontend/src/data/benchmark/types.ts`'s `LlmProposalRecord` gains the
mirrored optional field.

In
[`GuessChainVisualizer.tsx`](../../../frontend/src/components/benchmark/GuessChainVisualizer.tsx)'s
`ProposalRow`, for a `used` proposal that has a `categoryEvaluation`:

- Next to the guess-outcome `StatusPill`, a verdict `StatusPill` —
  `correct` → `tone="success"`, `partial` → `tone="neutral"`,
  `lucky` → `tone="failed"`; a `callError` evaluation shows a
  `tone="failed"` "Judge failed" pill instead.
- Below the row, a `<details>` "Category judge" block in the same
  `bench-step__detail` / `<pre>` style as the existing prompt/response
  and call-error blocks:
  - `proposedCategory` vs `actualCategory` and the `rationale` as plain
    lines;
  - a telemetry line: `judgeModel`, `judgeProvider`, token counts,
    `latencyMs`, `statusCode`;
  - for `callError`: `errorName` / `errorMessage`;
  - collapsible `<pre>` dumps of `requestBody`, `responseHeaders`,
    `responseBody`, and `rawResponseText` — `JSON.stringify(..., null, 2)`
    for the objects — exactly as
    [`CallErrorDetail`](../../../frontend/src/components/benchmark/GuessChainVisualizer.tsx#L181)
    renders the solve-call payloads today.

Small label/tone helpers (`categoryVerdictLabel`, `categoryVerdictTone`)
sit next to the existing `issueTagLabel` / `solvePromptStatusLabel`
helpers in that file.

### 7. Testing

**Backend — `category-evaluator.service.spec.ts` (new)**

- Word-set → `AnswerGroup` match is order-independent; a guess whose word
  set matches no group → no row written, warning logged.
- `evaluateProposal` on a fresh proposal writes one `judged` row with the
  verdict and every diagnostic field mapped from a mocked
  `OrchestratorService.judgeCategory` success.
- A mocked judge failure writes one `callError` row: `verdict` null,
  `status` `callError`, `errorName`/`errorMessage`/`statusCode` set,
  snapshot categories + `answerGroupId` still populated, and the method
  does not throw.
- Idempotency: a second `evaluateProposal` for a proposal that already has
  a row is a no-op unless `force`; with `force` the row is replaced, not
  duplicated (unique constraint holds).
- Not-in-scope proposals (`status` ≠ `used`, or guess ≠ `success`) → no
  row, no judge call.
- `enqueuePending({ limit })` selects only un-evaluated used+success
  proposals, newest `LlmProposal.id` first, honours `limit`, and adds one
  job per proposal — name `"evaluate-category"`, jobId `cat-eval-<id>`,
  data `{ llmProposalId }` — to the queue for the configured
  `JUDGE_PROVIDER` (assert against the OpenAI queue mock for the default).

**Backend — `strategy.service.spec.ts`, `getLeaderboard`**

- New test: a model with `CategoryEvaluation` rows across several runs —
  mixed `correct`/`partial`/`lucky` plus a `callError` — yields
  `categoryCorrect/Partial/Lucky` equal to the raw counts,
  `categoryEvaluated` = their sum (call error excluded), and
  `categoryAccuracy` = `correct / evaluated * 100`.
- A model with no evaluations, and every deterministic/shuffle row →
  `categoryAccuracy: null`, `categoryEvaluated: 0`.
- Existing cost / `avgIssues` tests need no mock changes — the new query
  is on its own injected repo; a test that doesn't stub
  `categoryEvaluationRepo.createQueryBuilder` gets the default mock
  returning `[]`, so every existing row comes out with zeroed category
  counts and `categoryAccuracy: null`.

**Backend — orchestrator `judge-category.test.ts` (new)**

- Happy path: a stubbed model returns a valid object → response carries
  `verdict`, `rationale`, `model`, `usage`, and the captured
  request/response detail.
- Model-call rejection → the endpoint returns the `SolveError`-shaped 502
  body with `code` and `details`, same as `/solve-assist`.
- Auth middleware already covered by existing app tests; add one case that
  `/judge-category` 401s without the header.

**Backend — worker**

- A job with `name === "evaluate-category"` is routed to
  `categoryEvaluatorService.evaluateProposal` with the payload's
  `llmProposalId`, and the `runLlmStrategy` path is not called.
- A `"run-strategy"` job on the same queue still routes to
  `runLlmStrategy` (no regression).

**Backend — endpoint**

- `POST /dispatch/evaluate-categories` calls `enqueuePending` with the
  clamped `limit` and returns `{ enqueued, llmProposalIds }`.
- `DispatchAuthGuard` behaviour is already covered generically; no
  route-specific auth test needed beyond confirming the guard is applied.

**Frontend**

- `StrategyTable` / `LeaderboardPage` tests: row fixtures gain the five
  category fields; assert the "Category IQ" header and a formatted cell
  value render for the LLM table and do **not** for the deterministic
  table; a row with `categoryEvaluated: 0` renders "—".
- `metrics.test.ts`: `"categoryAccuracy"` sorts highest-accuracy first
  and sends `null` rows last; `format` matches `formatSuccessRate`.
- `StrategyPuzzlePage` test: the breakdown block renders the split and the
  "not yet evaluated" empty state.
- `GuessChainVisualizer` test + `mockData`: a `used` proposal with a
  `judged` evaluation renders the verdict pill and the "Category judge"
  `<details>` with the proposed/actual/rationale lines; a `callError`
  evaluation renders the "Judge failed" pill and the error detail.

**Migration** — exercised by running it, the same as every existing
migration in this repo (no dedicated migration tests).
