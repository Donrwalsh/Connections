# Logging raw OpenAI request/response detail for strategy runs — design

## Problem

Strategy-run LLM solves (the `LLM_OPENAI`/`LLM_MINI` etc. strategies driven
by
[llm-strategy-runner.service.ts](../../../backend/src/modules/strategy/llm-strategy-runner.service.ts))
have been producing OpenAI API failures that are hard to diagnose after the
fact. Today, essentially none of the detail needed to troubleshoot a failed
call survives past the moment it happens:

- [orchestrator/src/solver.ts](../../../orchestrator/src/solver.ts)'s
  `classifyModelCallError` takes whatever the AI SDK throws — including a
  rich `APICallError` (`url`, `requestBodyValues`, `statusCode`,
  `responseHeaders`, `responseBody`, `isRetryable`) when the failure came
  from OpenAI itself — and discards everything except `err.message`.
- [orchestrator/src/app.ts](../../../orchestrator/src/app.ts) forwards that
  bare message back to the backend as JSON.
- [backend/src/modules/strategy/orchestrator.service.ts](../../../backend/src/modules/strategy/orchestrator.service.ts)
  retries a failed call up to 3 times, but only the *last* attempt's error
  message is ever visible to the caller — the earlier failed attempts leave
  no trace at all.
- [llm-strategy-runner.service.ts](../../../backend/src/modules/strategy/llm-strategy-runner.service.ts)
  only writes a `SolvePrompt` row when the orchestrator call succeeds
  (`outcome.ok`); a failed call just increments an in-memory counter
  (`classifyFailedCall`) and is never persisted anywhere.

Net effect: a flaky or failing OpenAI call today writes **zero rows** to
the database. There is no way to go back and see what was actually sent,
what OpenAI actually returned (or its error body), what HTTP status came
back, or whether the failure was one the existing retry logic should have
recovered from.

Even successful calls lose detail: `SolvePrompt` today stores only the
parsed response text and coarse telemetry (tokens, latency, temperature) —
not the raw request body sent to OpenAI, the response id, or response
headers.

## Goals

- Every real call to OpenAI made during a strategy-run solve step —
  successful or not, including calls that get retried by
  `orchestrator.service.ts` — leaves a database row with enough raw detail
  to diagnose it after the fact: exact request body, exact response (or
  error) body, response id/headers, HTTP status code, and whether the AI
  SDK considered the failure retryable.
- No call detail is lost between the moment `generateText` returns/throws
  in the orchestrator and the row landing in Postgres.

## Non-goals

- No coverage of the in-game AI Assist path (`/diagnose`) — this is scoped
  to strategy-run traffic (`/solve-assist`) only, per explicit scope
  decision.
- No coverage of the Ollama provider — only calls actually going to OpenAI
  are captured. `LLM_OLLAMA` strategy runs are unaffected.
- No retention policy or redaction — matches how the rest of this table
  (and `Guess`, `LlmProposal`) already behaves: rows accumulate with no
  cleanup, and prompt/response content here is just puzzle words and
  category text, not sensitive data.
- No new database table. This reuses and extends the existing
  `SolvePrompt` table rather than introducing a parallel one, so a single
  query against `SolvePrompt` (ordered by `promptNumber`, `attemptNumber`)
  gives the complete history of a solve step, successes and failures alike.
- The orchestrator remains stateless — it gains no database access. It only
  returns more detail in its existing HTTP response/error bodies; the
  backend continues to own all persistence.

## Design

### 1. Data flow

One `SolvePrompt` row is written per **attempt** at calling OpenAI, not
just per solve step. A single solve step (one iteration of the while loop
in `runLlmStrategy`) can now produce more than one row when
`orchestrator.service.ts` has to retry — all of them share the same
`promptNumber` (today's per-run step counter) and are distinguished by a
new `attemptNumber` column.

```
LlmStrategyRunner.runLlmStrategy()
  -> OrchestratorService.solveAssist()          [backend, retries up to 3x]
       -> POST /solve-assist                    [orchestrator, per attempt]
            -> generateText()                   [orchestrator, real OpenAI call]
```

**Orchestrator** ([solve-assist.ts](../../../orchestrator/src/solve-assist.ts)):
on success, capture `result.request.body` (the exact object the AI SDK sent
to OpenAI), `result.response.id`, `result.response.headers`,
`result.response.body` (OpenAI's parsed JSON response — confirmed via the
`@ai-sdk/openai` source that both are plain objects for the chat-completions
call path, not pre-stringified). On failure, `classifyModelCallError`
(solver.ts) is extended to pull `url`, `requestBodyValues`, `statusCode`,
`responseHeaders`, `responseBody`, `isRetryable` off an `APICallError` when
that's what was thrown, plus the elapsed `latencyMs`. Either way this bundle
rides along on the existing response/error path — the success JSON body and
the `SolveError`-driven error JSON body (`app.ts`) both gain a `callDetail`
object carrying it. No schema validation strips these fields today (the
`SolveAssistResponse` zod schema is only used to validate the incoming
request, never the outgoing response), so this is additive with no breaking
change to the wire format.

**Backend** ([orchestrator.service.ts](../../../backend/src/modules/strategy/orchestrator.service.ts)):
`executeWithRetry` currently returns only the final outcome. It's changed
to also collect one entry per HTTP round-trip to the orchestrator — success
or failure — into an `attempts: OpenAiCallAttempt[]` array, each carrying
`attemptNumber`, the `callDetail` bundle (when the orchestrator returned
one), and `latencyMs`. `solveAssist()` returns `{ outcome, attempts }`
instead of just `outcome`. A transport-level failure (timeout before the
orchestrator ever responds, network error) still produces an attempt entry
— just one with no `callDetail`, since no raw OpenAI detail was ever
received.

**Backend runner** ([llm-strategy-runner.service.ts](../../../backend/src/modules/strategy/llm-strategy-runner.service.ts)):
`globalPromptNumber` currently increments only inside the `outcome.ok`
branch. It moves to increment once per while-loop iteration regardless of
outcome, so every attempt in that iteration's `attempts[]` shares the same
`promptNumber`. Each attempt becomes one `Partial<SolvePrompt>` (built the
same way `currentPrompt` is today, just once per attempt instead of once
per successful step) and all of them are pushed onto the same
`pendingPrompts` array already flushed every loop iteration via
`StrategyRunStore.flushBatch` — no change needed to the flush mechanism
itself, just more rows going into the array that already exists. The
existing group-parsing/guess-evaluation/`classifyFailedCall` logic keeps
operating on the loop's final resolved `outcome`, unchanged.

### 2. Schema — new columns on `SolvePrompt`

All new columns are nullable except `attemptNumber` (default `1`, so
existing rows and non-retried steps are unaffected):

| Column | Type | Populated when |
|---|---|---|
| `attemptNumber` | `int`, default `1` | Always. 1-based, within `promptNumber`'s step. |
| `requestBody` | `jsonb` | Every attempt — exact object sent to OpenAI. |
| `responseId` | `text` | Success. |
| `responseHeaders` | `jsonb` | Whenever OpenAI/the SDK returned any (success or error). |
| `responseBody` | `jsonb` | Success (OpenAI's parsed response) or failure (OpenAI's error body). See parsing note below. |
| `statusCode` | `int` | Failure — the HTTP status OpenAI returned (401, 429, 500, ...). |
| `errorName` | `text` | Failure — e.g. `"APICallError"`. |
| `errorMessage` | `text` | Failure. |
| `isRetryable` | `boolean` | Failure — the AI SDK's own judgment on whether this class of failure is worth retrying (true for 429/5xx/network, false for 400/401/403). Distinguishes "this run failed because OpenAI was transiently erroring" from "this run failed because something's misconfigured" without having to parse `errorMessage` by hand. |

New `SolvePromptStatus` enum value: `callError` — the call itself failed
with no model text returned at all (`rawResponseText` stays `null` for
these rows; the error columns above are populated instead).

**`responseBody` parsing note:** the two sources for this column differ.
On success, `result.response.body` is already a parsed JS object — stored
directly. On failure, `APICallError.responseBody` is a raw string with no
guarantee of being valid JSON (could be a gateway HTML error page, plain
text, etc.), so it can't always be dropped straight into a `jsonb` column.
Write path: if the value is already an object, store it as-is; if it's a
string, attempt `JSON.parse` and store the parsed object on success (true
for virtually all real OpenAI error bodies, which are JSON), otherwise
store the raw string itself — a bare string is still valid `jsonb`. This
guarantees the column never fails to write and stays queryable whenever the
body was real JSON. `requestBody` doesn't need this treatment — confirmed
via the AI SDK source that it's always a plain object at the call site.

### 3. Testing

- `orchestrator/src/solve-assist.test.ts`: assert `callDetail` is populated
  correctly on success, and that a thrown `APICallError` (mocked with known
  field values) has its fields captured rather than swallowed by
  `classifyModelCallError`.
- `backend/src/modules/strategy/orchestrator.service.spec.ts`: assert
  `attempts[]` is built correctly across a retry sequence (e.g. attempt 1
  fails, attempt 2 succeeds → two entries, correct `attemptNumber`s and
  `callDetail` on each).
- `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`:
  assert one `SolvePrompt` row is written per attempt, all sharing the
  step's `promptNumber`, each with a distinct `attemptNumber`.
- New TypeORM migration alongside the existing ones in
  `backend/src/migrations/`, exercised the same way those already are (this
  repo's migrations don't currently carry dedicated tests beyond running
  them).
