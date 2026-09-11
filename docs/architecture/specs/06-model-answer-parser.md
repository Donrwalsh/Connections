# Candidate 6 — One home for the model-answer parser: implementation spec

**Origin:** This spec was produced in a grilling/planning session (the `grill-me` skill), not
through the Superpowers spec workflow. It realises the architecture-deepening artifact
`docs/architecture/06-model-answer-parser.html`. Related artifact absorbed by this work:
`docs/architecture/07-fold-diagnose-into-solve-assist.html` (both artifacts explicitly
recommend doing 6 and 7 together — 7 is what makes the parser unification a one-call-site
problem instead of two).

**Scope expansion beyond the artifacts:** during grilling, a standing naming preference
surfaced that both artifacts' own code sketches actually violate — `07`'s proposed
`solveAssistStep` name, and `06`'s and `07`'s continued use of `SolveAssistRequestSchema`/
`SolveAssistResponseSchema`/`/solve-assist`, all keep "assist" language on the automated
strategy-runner's path. The user wants "assist"/"AI Assist" language reserved for the
frontend's in-game button (`/diagnose`); the automated-solving path gets a different name.
This spec folds that rename in, plus the workspace/Docker/CI plumbing the shared package
needs (grilled separately — see the memory `reserve-ai-assist-naming-for-button-only.md` and
this session's Q1–Q9). None of this widens behavioural scope — no schema field the artifacts
didn't already propose, no new runtime behaviour beyond `06`'s parser unification and `07`'s
route fold.

**Branch:** `refactor/answer-grammar-and-solve-step`, off `master` (candidate 5 —
split-strategy-service — is already merged; no ordering dependency on it beyond that).

**Shape of delivery:** 3 separate PRs, merged sequentially. Each builds and passes
`npm run test` (orchestrator + backend) on its own.

---

## Goal

Turning the model's `### GROUPS` / `### ANSWER` response text into structured word groups is
one contract, implemented four times (orchestrator's `solve-assist.ts` and `assist.ts`,
backend's `parse-groups-section.ts`, and `backfill-issue-tags.ts`'s import of the latter) —
with a bug (the parenthetical-strip fix) that has already been fixed twice, months apart,
because the concept has no owner. Give it one home: a new shared package the orchestrator and
backend both depend on. Alongside that, fold `/diagnose` into the same model-call step
`/solve-assist` already uses (candidate 7), and rename every "solve-assist"/`solveAssist`/
`SolveAssist*` identifier on the automated-solving path so that language is reserved for the
button.

---

## Scope

### In scope

- New workspace package `packages/answer-grammar`, exporting one pure function that is the
  single grammar for the model's response text.
- Deleting `backend/src/modules/strategy/parse-groups-section.ts` and orchestrator's
  `parseGroupProposals`/`parseAnswerGroups` in favour of the shared function.
- Widening the orchestrator's automated-solving response schema to carry the structured parse
  it already computes, so `llm-strategy-runner.service.ts` stops re-parsing raw text.
- Folding `orchestrator/src/assist.ts` (`runAssistStep`, backs `/diagnose`) into the same step
  function the automated path uses, parameterised by a `captureTelemetry` flag.
- Renaming the automated-solving route, file, function, schemas, and every "solve-assist" /
  `solveAssist` / `SolveAssist*` identifier in `orchestrator/` and `backend/` (confirmed by
  repo-wide grep: nothing outside those two packages references any of these names — the
  frontend only ever calls `/diagnose`).
- Root npm workspaces (`orchestrator`, `backend`, `packages/*`), collapsing the two existing
  lockfiles into one root lockfile.
- Docker build-context and CI changes needed to make `packages/answer-grammar` reachable by
  both services' builds.

### Out of scope

| Item | Why deferred |
|---|---|
| Moving `wordNotOnList` off the backend | Genuinely needs the puzzle board (`run.availableWords` / `puzzle.answerGroups`), which the orchestrator never sees. See "Corrections to the artifact" below for why `unclassified` is *not* in this category, unlike the artifact claimed. |
| Deduplicating the *board-check* itself | `evaluateProposals` (`llm-strategy-runner.service.ts:602–648`) and `backfill-issue-tags.ts` (lines 104–114) each independently re-implement "is this proposed word one of the puzzle's 16?" — a *third* copy of a similar concept, distinct from the text-grammar duplication this spec fixes. Real finding, real seam, but a different candidate: it's a board-aware check, not a text-parsing one, and folding it in here would double this PR's diff for an unrelated concern. |
| `docs/architecture/08` (persist prompt text), other provider-pool candidates | Separate candidates, separate risk surfaces. |
| Turning `packages/answer-grammar`'s `dist` build into a general "shared packages" convention document | One package doesn't justify a new doc; revisit if a second shared package appears. |

---

## Corrections to the artifact

The `06` artifact's design was written from a read of `solve-assist.ts` and `assist.ts`
(orchestrator) but not a full read of `parse-groups-section.ts` and its callers (backend).
Verified against the actual code:

**`unclassified` is text-only — it does not need the board.** The artifact splits the four
`SolvePromptIssueTag` values into "two text-only, move to the orchestrator"
(`parentheticalStripped`, `groupCountOff`) and "two need the board, stay backend"
(`wordNotOnList`, `unclassified`). Reading `parse-groups-section.ts` end to end:
`parseGroupsSection(responseText, fallbackGroups)` takes **no puzzle/board argument at all**,
and its `UNCLASSIFIED` tag (lines 114–118) is a pure function of the response text's own
"Group N" headings — a heading number that appears but never produced a parsed word group and
isn't already explained by a wrong word count. The entity's own doc comment
(`solve-prompt.entity.ts:30–35`) confirms this: `unclassified` exists "when a response fails in
a way none of the other tags explain" — a parse-shape concept, not a board concept. Only
`wordNotOnList` (added separately, in `evaluateProposals`, using `run.availableWords` /
`puzzle.answerGroups`) actually needs the board. So the shared package's `textIssues` union
carries **three** values (`parentheticalStripped`, `groupCountOff`, `unclassified`), not two;
only `wordNotOnList` stays backend-side, added by `evaluateProposals` exactly as today.

**The canonical implementation is backend's `parseGroupsSection`, not orchestrator's
`parseGroupProposals`.** The artifact's deletion test says deleting the backend parser
"concentrates into the orchestrator's parser, which already does most of the work." That's
backwards on inspection: orchestrator's `parseGroupProposals` (`solve-assist.ts:55–75`) matches
`Group\s+(\d+)` but **discards** the captured number (`match[1]` is captured, never read) and
just pushes proposals in regex-match order into a flat array. Backend's `parseGroupsSection`
tracks the actual heading number per chunk, indexes `parsedGroupWords[groupNum - 1]`
positionally, and uses the gaps between "headings seen" and "words successfully parsed" to
derive `groupCountOff` and `unclassified`. Porting orchestrator's simpler version into the
shared package would silently regress the position/gap tracking that makes `unclassified`
possible at all. The shared package's implementation is a straight port of
`parse-groups-section.ts`'s logic, not `solve-assist.ts`'s.

**`parseGroupsSection`'s live call site is `llm-strategy-runner.service.ts:384–390`**, inside
the success branch, right after a non-empty `data.groups` — not line 434 as the artifact
stated (434 is inside the *failure*-branch's `classifyFailedCall` call, an unrelated path).
Re-grep before implementing; these numbers will drift.

**The function takes a `fallbackGroups` parameter that must carry over.**
`parseGroupsSection(responseText, fallbackGroups)`'s second argument is the orchestrator's own
already-parsed `### ANSWER` lines (`data.groups`), used verbatim when the structured
`### GROUPS` block yields nothing (`parse-groups-section.ts:97–101`). The shared `parseAnswer`
must replicate this exact two-tier fallback — parsing `### GROUPS` primarily, falling back to
`### ANSWER` lines — not just parse one section in isolation.

**`categoryByGroup` is a `Map<number, string>` in real usage, not a `Record`.** The artifact's
code sketch used `Record<number, string>`; `buildProposalEntries` consumes it as a `Map`
today. Keep it a `Map` in the shared type to avoid a needless conversion at the one real call
site.

**`/diagnose`'s prompt was never asking for the `### GROUPS`/`### ANSWER` format at all** —
found while implementing PR 3, not during grilling. `frontend/src/lib/aiAssistPrompts.ts`
asks the model for free-form reasoning followed by a bare `"ANSWER:"` line (no `###`, no
`### GROUPS` section); `llm-strategy-runner.service.ts`'s `buildInitialPrompt`/
`buildRetryPrompt` ask for `### GROUPS` + `### ANSWER`. `assist.ts`'s simpler parser (only
matching bare `ANSWER:`) was therefore not a stale copy of `solve-assist.ts`'s — it was
correctly parsing the different, simpler contract its own prompt actually asked for. Doc 7's
framing of this as parser drift/staleness was wrong; folding `/diagnose` onto the shared
`parseAnswer` as originally proposed would have broken it. Confirmed with the user (who wants
the two prompt formats aligned anyway) and resolved by updating
`frontend/src/lib/aiAssistPrompts.ts` to also emit `### GROUPS` (with an added `Reasoning:`
line per group, preceding `Category:`/`Words:`, so the button's reasoning-per-group UX is
preserved — `Game.tsx` renders `response` verbatim in a `<pre>`, and the shared parser's
`Category:`/`Words:` regexes ignore any other line in a group's chunk, so the extra
`Reasoning:` line is harmless) and `### ANSWER`, in the same structure and wording as the
backend's prompts. Verified end-to-end: a realistic filled-in response in the new format
parses through the real `parseAnswer` with the expected `groups`/`proposalWords`/
`categoryByGroup`, zero `textIssues`.

---

## Design

### The shared package

```
packages/answer-grammar/
  package.json         # name "answer-grammar", private: true, main "dist/index.js", types "dist/index.d.ts"
  tsconfig.json
  src/
    parse-answer.ts    # ported, unchanged behaviour, from parse-groups-section.ts
    parse-answer.test.ts
    index.ts           # re-exports parseAnswer, ParsedAnswer, AnswerTextIssue
```

```ts
// packages/answer-grammar/src/parse-answer.ts
export type AnswerTextIssue = "parentheticalStripped" | "groupCountOff" | "unclassified";

export interface ParsedAnswer {
  proposalWords: string[][];               // indexed by group number - 1; ### ANSWER fallback used verbatim when ### GROUPS parse is empty
  categoryByGroup: Map<number, string>;    // "Group N" heading number -> its Category: text
  textIssues: AnswerTextIssue[];
}

/**
 * responseText: the model's raw text ("### GROUPS" / "### ANSWER" sections).
 * fallbackGroups: already-parsed "### ANSWER" lines to fall back to when the
 * "### GROUPS" block yields nothing — see parse-groups-section.ts's original
 * doc comment for why this two-tier fallback exists.
 */
export function parseAnswer(responseText: string, fallbackGroups: string[][]): ParsedAnswer;
```

This is a straight port of `parse-groups-section.ts`'s body (see "Corrections" above) — no
behaviour change, only the module boundary and the name (`parseGroupsSection` → `parseAnswer`,
`issueTags: string[]` → `textIssues: AnswerTextIssue[]` for the narrower, text-only type).
Orchestrator's own `parseGroupProposals`/`parseAnswerGroups`/`WORDS_PARENTHETICAL_RE` in
`solve-assist.ts`, and their equivalents in `assist.ts`, are deleted outright — not kept as a
second, simpler variant.

### Workspace + Docker + CI plumbing

- Root `package.json`: `{"private": true, "workspaces": ["orchestrator", "backend", "packages/*"]}`.
  `orchestrator/package-lock.json` and `backend/package-lock.json` are deleted; one root
  `package-lock.json` replaces both.
- Root build script orders the dependency correctly:
  `packages/answer-grammar` must build (`tsc`) before either consumer, since both import its
  compiled `dist/index.js`/`.d.ts` (no bundler/monorepo tool like Turborepo is introduced for
  one package — explicit ordering in each Dockerfile's build stage is enough).
- `orchestrator/Dockerfile` / `backend/Dockerfile`: build context becomes the repo root.
  `COPY package.json package-lock.json* ./` → `COPY package.json package-lock.json* ./` at
  root plus each workspace's own `package.json` (`COPY orchestrator/package.json
  ./orchestrator/`, `COPY packages/answer-grammar/package.json ./packages/answer-grammar/`),
  `RUN npm ci` at root (installs + links all three workspaces), then
  `COPY packages/ ./packages/` + `COPY orchestrator/ ./orchestrator/` (or `backend/`), then
  `RUN npm run build --workspace=packages/answer-grammar && npm run build --workspace=orchestrator`
  (respectively `--workspace=backend`).
- `docker-compose.yml` / `docker-compose.prod.yml`: `orchestrator`/`backend`/`worker` services'
  `build.context` → repo root, explicit `dockerfile:` path (`orchestrator/Dockerfile` /
  `backend/Dockerfile`).
- New root `.dockerignore`: `**/node_modules`, `**/dist`, `.git`, `frontend/`, `docs/`,
  `.worktrees/`, `.claude/`.
- Dev-only: `docker-compose.yml` gains a bind mount for `./packages/answer-grammar` alongside
  the existing `./orchestrator/src` / `./backend/src` mounts, so shared-package edits are
  visible without a rebuild. **As built:** confirm whether `tsx watch` picks up the workspace
  package's *source* directly (no separate watch/build step needed for dev) or whether dev
  also needs the package's `dist` rebuilt on change — verify during Step 1 rather than assume.
- `.github/workflows/orchestrator-tests.yml` / `backend-tests.yml`: the `Install dependencies`
  step's `working-directory` becomes the repo root (`npm ci` against the new root lockfile,
  `cache-dependency-path: package-lock.json`); the later typecheck/build/test steps keep their
  existing per-directory `working-directory`, unaffected by the workspace root install.
- README: no Coolify reconfiguration needed (confirmed — `docker-compose.prod.yml` deploys as
  one Coolify resource running the whole compose file from the repo root already); add a note
  to the "Getting started" section that a fresh clone now runs `npm ci` once at the repo root,
  not per-service.

### Naming map

| Before | After |
|---|---|
| `orchestrator/src/solve-assist.ts` | deleted; merges into `orchestrator/src/answer-step.ts` |
| `orchestrator/src/assist.ts` | deleted; `/diagnose` becomes a thin adapter over `answer-step.ts` |
| `solveAssist(messages, model, provider, contextWindow, abortSignal)` | `runAnswerStep(messages, opts: AnswerStepOpts)` |
| `SolveAssistResult` (orchestrator interface) | `AnswerStepResult` |
| `SOLVE_ASSIST_TEMPERATURE` / `ASSIST_TEMPERATURE` (two consts, same value) | one `ANSWER_STEP_TEMPERATURE = 0.7` |
| Route `POST /solve-assist` | `POST /solve-step` |
| `SolveAssistRequestSchema` / `SolveAssistResponseSchema` (`types.ts`) | `SolveStepRequestSchema` / `SolveStepResponseSchema` |
| `AssistRequestSchema` / `AssistResponseSchema` | **unchanged** — this is `/diagnose`'s wire contract, already correctly named |
| `backend/…/orchestrator.service.ts`'s `solveAssist(...)` method | `requestSolveStep(...)` |
| `SolveAssistSuccess` / `SolveAssistFailure` / `SolveAssistOutcome` (backend interfaces) | `SolveStepSuccess` / `SolveStepFailure` / `SolveStepOutcome` |
| Class/method doc comments calling this "the unified AI Assist flow" (`orchestrator.service.ts:91–93`, `102–104`) | reworded to describe it as the automated strategy runner's per-step model call; "AI Assist" language stays reserved for `/diagnose` |
| `orchestrator/src/solve-assist.test.ts` + `assist.test.ts` | merged into `orchestrator/src/answer-step.test.ts` |
| `backend/…/parse-groups-section.ts` + `parse-groups-section.spec.ts` | deleted; coverage lives in `packages/answer-grammar/src/parse-answer.test.ts` |
| `docker-compose.local-ollama-worker.yml` comment referencing `POST /solve-assist` | updated to `/solve-step` |

`backend/…/llm-strategy-runner.service.ts`'s error-message strings ("Solve-assist failed") and
`orchestrator/src/app.ts`'s route error strings get the same treatment (`"Solve-step failed"`).

### `captureTelemetry` and the merged step function

```ts
// orchestrator/src/answer-step.ts
export interface AnswerStepOpts {
  model?: string;
  provider?: ModelProvider;
  contextWindow?: number;
  abortSignal?: AbortSignal;
  captureTelemetry?: boolean;   // default true; /diagnose passes false
}

export async function runAnswerStep(
  messages: ChatMessage[],
  opts: AnswerStepOpts = {},
): Promise<AnswerStepResult> {
  const captureTelemetry = opts.captureTelemetry ?? true;
  const startTime = captureTelemetry ? Date.now() : undefined;
  const result = await generateText({
    model: getModel(opts.provider ?? defaultProvider(), opts.model, opts.contextWindow),
    messages,
    temperature: ANSWER_STEP_TEMPERATURE,
    // Only ask the AI SDK to assemble request/response body detail when the
    // caller will actually use it — /diagnose never persists telemetry, so
    // this must be a real skip, not compute-then-discard.
    ...(captureTelemetry ? { include: { requestBody: true, responseBody: true } } : {}),
    maxRetries: 0,
    abortSignal: opts.abortSignal,
  });
  // ... latencyMs / usage only computed when captureTelemetry
}
```

`/diagnose` becomes:

```ts
// app.ts
app.post("/diagnose", bodyLimit(...), async (c) => {
  const parsed = AssistRequestSchema.safeParse(await c.req.json());
  ...
  const r = await runAnswerStep(parsed.data.messages, { captureTelemetry: false });
  return c.json({ response: r.response, groups: r.groups, model: r.model }, 200);
});
```

`AssistRequestSchema`/`AssistResponseSchema` stay exactly as-is — the frontend's contract
doesn't move. A test in `app.test.ts` pins the `/diagnose` response to exactly these three
keys, so `runAnswerStep`'s richer return never leaks onto the button's wire contract.

`/solve-step`'s route body:

```ts
app.post("/solve-step", bodyLimit(...), async (c) => {
  const parsed = SolveStepRequestSchema.safeParse(await c.req.json());
  ...
  const result = await runAnswerStep(parsed.data.messages, {
    model: parsed.data.model,
    provider: parsed.data.provider as ModelProvider,
    contextWindow: parsed.data.contextWindow,
    abortSignal: c.req.raw.signal,
  });
  const response: SolveStepResponse = result;
  return c.json(response, 200);
});
```

`SolveStepResponseSchema` widens `AssistResponseSchema` with `proposals`/`categoryByGroup`/
`textIssues` (the `ParsedAnswer` fields, computed once inside `runAnswerStep` via the shared
`parseAnswer`) plus the raw-detail fields the code already returns at runtime but the schema
never declared (`requestBody`, `responseId`, `responseHeaders`, `responseBody`) — this closes
the wire-contract/payload drift the artifact flagged. `orchestrator.service.ts`'s
`requestSolveStep` mapper forwards the new fields; `llm-strategy-runner.service.ts:384–390`
stops calling `parseAnswer`/`parseGroupsSection` itself and instead reads
`const { proposalWords, categoryByGroup, textIssues } = data;` straight off the response.

`backfill-issue-tags.ts` imports `parseAnswer` from `answer-grammar` in place of
`parseGroupsSection` from the deleted `parse-groups-section.ts`; its own separate
`wordNotOnList` re-derivation (lines 104–114) is untouched — that's the board-aware check, out
of scope here (see "Out of scope" above).

---

## Steps

### PR 1 — Workspace + Docker + CI infra, plus the shared package (additive only)

No consumer is switched over yet; `solve-assist.ts`, `assist.ts`, and
`parse-groups-section.ts` all keep running exactly as today. This isolates all Docker/CI/
workspace risk from any behaviour change.

- Add root `package.json` with `workspaces`, delete the two per-service lockfiles, generate
  one root `package-lock.json`.
- Create `packages/answer-grammar` with `parseAnswer` ported verbatim from
  `parse-groups-section.ts` (see "Corrections" above — port the backend version, not
  orchestrator's), plus its own full test suite (every existing
  `parse-groups-section.spec.ts` assertion carries over).
- Update both Dockerfiles, both compose files, add `.dockerignore`, update the dev bind
  mounts, update both CI workflows' install step.
- Verify: `npm ci` at root succeeds; `docker compose build orchestrator backend` succeeds;
  both services' existing test suites stay green, untouched; the new package's own test suite
  is green in CI.

### PR 2 — Parser unification + naming rename (orchestrator + backend, together)

Delivered as one PR spanning both services, since the route rename in this step is a breaking
cross-service contract change — keeping it in one PR/commit means the build is never green
against a stale contract on either side.

- Orchestrator: delete `parseGroupProposals`/`parseAnswerGroups`/`WORDS_PARENTHETICAL_RE` from
  `solve-assist.ts`; rename the file to `answer-step.ts`; rename `solveAssist` →
  `runAnswerStep`, importing `parseAnswer` from `answer-grammar`. Widen `SolveAssistRequestSchema`/
  `SolveAssistResponseSchema` → `SolveStepRequestSchema`/`SolveStepResponseSchema` with the new
  structured fields. Rename the route to `/solve-step`. `solve-assist.test.ts` renamed to
  `answer-step.test.ts` (assist.ts's tests are not merged in yet — that's PR 3).
- Backend: rename `orchestrator.service.ts`'s `solveAssist` → `requestSolveStep`, its interfaces
  (`SolveAssistSuccess`/`Failure`/`Outcome` → `SolveStepSuccess`/`Failure`/`Outcome`), its URL
  literal to `/solve-step`, and its doc comments (no more "unified AI Assist flow"). Delete
  `parse-groups-section.ts`; `llm-strategy-runner.service.ts:384–390` reads
  `proposalWords`/`categoryByGroup`/`textIssues` off the response instead of calling
  `parseGroupsSection` itself. `backfill-issue-tags.ts` imports `parseAnswer` from
  `answer-grammar`.
- Run `npm run test` (both) + orchestrator's `app.test.ts` (route contract) +
  `llm-strategy-runner.service.spec.ts` (now asserting on structured input, no raw
  `### GROUPS` fixture strings needed for the parse step itself — though the fixtures still
  need real response text to feed `runAnswerStep`'s mock).

### PR 3 — Fold `/diagnose` into `runAnswerStep`, final naming sweep

- **Prerequisite, found during implementation (see "Corrections" above):** update
  `frontend/src/lib/aiAssistPrompts.ts`'s `buildInitialPrompt`/`buildRetryPrompt` to emit
  `### GROUPS` (with a per-group `Reasoning:` line ahead of `Category:`/`Words:`) and
  `### ANSWER`, matching the backend's prompt structure, instead of the old bare `"ANSWER:"`
  format. Without this, folding `/diagnose` onto the shared `parseAnswer` would silently change
  (break) how its responses parse. Update `aiAssistPrompts.test.ts` to match.
- Add `AnswerStepOpts.captureTelemetry` (real skip, not compute-then-discard — see Design).
- Delete `assist.ts`; `/diagnose` becomes the thin adapter shown above.
- Merge `assist.test.ts`'s cases into `answer-step.test.ts`.
- `app.test.ts` gains the "`/diagnose` response is exactly `{response, groups, model}`"
  assertion.
- Final sweep: grep the repo for `solve-assist`/`solveAssist`/`SolveAssist` — expect zero
  hits outside git history and this spec's own "before" column. Fix
  `docker-compose.local-ollama-worker.yml`'s and `README.md`'s remaining references.

---

## Tests

Characterisation-first, matching candidates 1 and 5's approach:

- `packages/answer-grammar/src/parse-answer.test.ts` carries every assertion from the deleted
  `parse-groups-section.spec.ts` verbatim (same table-driven cases), plus orchestrator-specific
  cases that `parseGroupProposals`/`parseAnswerGroups` covered but `parseGroupsSection` didn't
  previously need to (there was no orchestrator-side consumer of the richer parser before).
- `answer-step.test.ts` (PR 2) carries `solve-assist.test.ts`'s cases against `runAnswerStep`;
  (PR 3) gains `assist.test.ts`'s cases run with `captureTelemetry: false`.
- `llm-strategy-runner.service.spec.ts`: existing assertions on `issueTags`/`categoryMap`
  content are unchanged in substance (same tag values, same category strings) — only the code
  path producing them moves from a local `parseGroupsSection` call to reading the orchestrator
  response's own fields.
- A parenthetical-strip regression is now a one-line addition to one table-driven spec in
  `packages/answer-grammar`, and cannot regress on only one side ever again.

---

## Risks

- **PR 2 is a real cross-service contract change**, unlike candidate 1's provider-pool work
  (which kept its wire contract stable specifically so backend/orchestrator could deploy
  independently). This repo's Coolify deployment always redeploys both services from the same
  compose file at once, so lockstep is guaranteed in production — but confirm no other
  environment (a stale local dev container, e.g.) runs one service against the other's old
  image before rebuilding.
- **`unclassified`'s move is the main behavioural risk of the "Corrections" section.** Moving
  it into the shared package changes nothing about *when* it fires (still purely a function of
  response text), but confirm `evaluateProposals` never itself pushes `UNCLASSIFIED` anywhere
  the grep missed — it should only ever push `WORD_NOT_ON_LIST`.
- **Workspace/Docker change (PR 1) touches production build/deploy machinery** without
  changing any runtime behavior — the highest-consequence-if-wrong, lowest-complexity-to-review
  part of this work. Verify a full `docker compose -f docker-compose.prod.yml build` locally
  before merging, not just `npm run test`.
- **No shim, no lockstep requirement within a single PR.** Same approach as candidate 5: each
  PR updates all of its own step's callers in the same commit, so the build stays green at
  every commit without a transition window.
