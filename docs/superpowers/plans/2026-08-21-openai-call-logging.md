# OpenAI Call Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every real OpenAI call made during a strategy-run solve step — successful, retried, or terminally failed — leaves a `SolvePrompt` row in Postgres carrying the exact request/response detail needed to diagnose it later.

**Architecture:** The orchestrator (`orchestrator/src/solve-assist.ts`) already runs `generateText`; it starts capturing the raw request/response it already receives from the AI SDK, on both success and failure, and surfaces it in its existing HTTP response/error bodies (no wire-format schema change — neither is validated on the way out today). The backend's `orchestrator.service.ts` stops discarding everything but the last retry's error message, and instead collects one record per real OpenAI call attempt. `llm-strategy-runner.service.ts` writes one `SolvePrompt` row per attempt (not just per successful step), all sharing that step's `promptNumber` and distinguished by a new `attemptNumber` column.

**Tech Stack:** NestJS + TypeORM (backend), Hono + Vercel AI SDK v7 (orchestrator), Jest (backend tests), Vitest (orchestrator tests), Postgres.

**Spec:** [docs/superpowers/specs/2026-08-21-openai-call-logging-design.md](../specs/2026-08-21-openai-call-logging-design.md)

## Global Constraints

- Scope is strategy-run traffic only (`/solve-assist`) — the in-game AI Assist path (`/diagnose`) is untouched.
- Only calls actually made to OpenAI are captured — `LLM_OLLAMA` runs are unaffected.
- No new database table — this extends the existing `SolvePrompt` table.
- The orchestrator stays stateless (no DB access added to it).
- No retention policy or redaction — matches how `SolvePrompt`/`Guess`/`LlmProposal` already behave.

## Interface Note (deviation from the spec's draft wording)

The spec's "Data flow" section sketches `solveAssist()` returning `{ outcome, attempts }` instead of just `outcome`. Implementing it that way would change `OrchestratorService.solveAssist()`'s return shape and break every one of the ~15 existing mocks in `llm-strategy-runner.service.spec.ts` that resolve it directly to a `SolveAssistOutcome`. This plan achieves the same behavior — every attempt captured — by keeping `solveAssist()`'s return type exactly as it is today (`Promise<SolveAssistOutcome>`, the `{ok:true,data}|{ok:false,error}` union) and adding the raw detail as new optional fields directly on `data`/`error`, plus an optional `retriedAttempts` array on each holding the earlier attempts that failed and got retried before this outcome. This is behaviorally identical (every attempt's detail is still captured and returned) with far lower blast radius. The spec's schema and goals are otherwise implemented as written.

---

### Task 1: Orchestrator captures raw OpenAI call detail

**Files:**
- Modify: `orchestrator/src/solver.ts`
- Modify: `orchestrator/src/solve-assist.ts`
- Test: `orchestrator/src/solve-assist.test.ts`

**Interfaces:**
- Consumes: AI SDK v7's `generateText` result shape — `result.request.body` (object sent to OpenAI), `result.response.id/headers/body`, `result.usage`. Confirmed via `@ai-sdk/openai` source: for the chat-completions call path, both `request.body` and `response.body` are plain JS objects, not pre-stringified. `APICallError` (re-exported from `"ai"`, defined in `@ai-sdk/provider`) carries `url`, `requestBodyValues`, `statusCode`, `responseHeaders`, `responseBody: string`, `isRetryable`, and sets `.name = "AI_APICallError"`.
- Produces: `SolveAssistResult` gains `requestBody?: unknown`, `responseId?: string`, `responseHeaders?: Record<string, string>`, `responseBody?: unknown`. `SolveErrorDetails` (and therefore every `SolveError.details` bag, which `app.ts` already serializes verbatim into its JSON error body under `details`) gains the same four fields plus `statusCode?: number`, `errorName?: string`, `isRetryable?: boolean`. `app.ts` needs no changes — it already forwards `result` and `err.details` as-is.

- [ ] **Step 1: Write the failing tests for `solve-assist.ts`'s raw-detail capture**

Add to `orchestrator/src/solve-assist.test.ts` (new imports plus a new `describe("solveAssist", ...)` block; keep the existing `parseGroupProposals` block below it unchanged):

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGroupProposals, solveAssist } from "./solve-assist.js";

describe("solveAssist", () => {
  const generateTextMock = vi.hoisted(() => vi.fn());

  vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();
    return { ...actual, generateText: generateTextMock };
  });

  const MESSAGES = [{ role: "user" as const, content: "solve this puzzle" }];

  beforeEach(() => {
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("captures the raw request/response detail on a successful call", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      response: {
        modelId: "gpt-4.1-nano",
        id: "resp_123",
        headers: { "x-request-id": "req_123" },
        body: { id: "resp_123", choices: [{ message: { content: "### ANSWER..." } }] },
      },
      request: {
        body: { model: "gpt-4.1-nano", messages: [{ role: "user", content: "solve this puzzle" }] },
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const result = await solveAssist(MESSAGES);

    expect(result.requestBody).toEqual({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "solve this puzzle" }],
    });
    expect(result.responseId).toBe("resp_123");
    expect(result.responseHeaders).toEqual({ "x-request-id": "req_123" });
    expect(result.responseBody).toEqual({
      id: "resp_123",
      choices: [{ message: { content: "### ANSWER..." } }],
    });
  });

  it("surfaces APICallError detail instead of discarding it", async () => {
    const { APICallError } = await import("ai");
    generateTextMock.mockRejectedValueOnce(
      new APICallError({
        message: "Rate limit exceeded",
        url: "https://api.openai.com/v1/chat/completions",
        requestBodyValues: { model: "gpt-4.1-nano" },
        statusCode: 429,
        responseHeaders: { "retry-after": "30" },
        responseBody: '{"error":{"message":"Rate limit exceeded"}}',
        isRetryable: true,
      }),
    );

    await expect(solveAssist(MESSAGES)).rejects.toMatchObject({
      code: "model_error",
      details: {
        requestBody: { model: "gpt-4.1-nano" },
        statusCode: 429,
        responseHeaders: { "retry-after": "30" },
        responseBody: '{"error":{"message":"Rate limit exceeded"}}',
        isRetryable: true,
        errorName: "AI_APICallError",
      },
    });
  });

  it("still classifies a plain non-API error as model_error with no call detail", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("fetch failed"));

    await expect(solveAssist(MESSAGES)).rejects.toMatchObject({
      code: "model_error",
      details: { requestBody: undefined, statusCode: undefined },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd orchestrator && npx vitest run src/solve-assist.test.ts`
Expected: FAIL — `solveAssist` isn't exported yet from a build that reads `result.request`/`result.response` fields, and `result.requestBody` etc. are `undefined` on the returned object; `classifyModelCallError` doesn't yet pull anything off `APICallError`.

- [ ] **Step 3: Update `orchestrator/src/solver.ts`**

Replace the whole file:

```typescript
import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
} from "ai";
import { type SolveErrorCode } from "./types.js";

export interface SolveErrorDetails {
  prompt?: string;
  model?: string;
  contextWindow?: number;
  latencyMs?: number;
  temperature?: number;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  statusCode?: number;
  errorName?: string;
  isRetryable?: boolean;
}

/**
 * Typed failure from a solve step. `code` distinguishes recoverable bad
 * model output (duplicate/invalid groups) from unrecoverable model/network
 * failures so the backend can react appropriately (re-prompt vs. abort).
 */
export class SolveError extends Error {
  constructor(
    readonly code: SolveErrorCode,
    message: string,
    readonly details: SolveErrorDetails = {},
  ) {
    super(message);
    this.name = "SolveError";
  }
}

/**
 * Classifies an AI SDK failure from generateObject/generateText into a typed
 * SolveError. Malformed-but-present output (no/undecodable object) is
 * recoverable — callers may re-prompt. Provider/network failures are not.
 *
 * When the failure is an APICallError (a real OpenAI request that got a
 * non-2xx response, or a network-level failure the AI SDK wraps the same
 * way), its raw request/response detail — otherwise lost the moment this
 * function returns — rides along on the thrown SolveError's `details`, so
 * the backend can persist it for troubleshooting.
 */
export function classifyModelCallError(
  err: unknown,
  details: SolveErrorDetails,
): SolveError {
  const message = err instanceof Error ? err.message : "Unknown model error";

  if (
    err instanceof NoObjectGeneratedError ||
    err instanceof TypeValidationError ||
    err instanceof JSONParseError
  ) {
    return new SolveError(
      "invalid_group",
      `Model produced a malformed response: ${message}`,
      details,
    );
  }

  const apiDetails: SolveErrorDetails = APICallError.isInstance(err)
    ? {
        requestBody: err.requestBodyValues,
        statusCode: err.statusCode,
        responseHeaders: err.responseHeaders,
        responseBody: err.responseBody,
        isRetryable: err.isRetryable,
      }
    : {};

  return new SolveError("model_error", `Model call failed: ${message}`, {
    ...details,
    ...apiDetails,
    errorName: err instanceof Error ? err.name : undefined,
  });
}
```

- [ ] **Step 4: Update `orchestrator/src/solve-assist.ts`**

Replace the `SolveAssistResult` interface (lines 6-22) with:

```typescript
export interface ParsedGroupProposal {
  words: string[];
  category: string;
}

export interface SolveAssistResult {
  response: string;
  groups: string[][];
  proposals: ParsedGroupProposal[];
  model: string;
  latencyMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
}
```

Replace the body of `solveAssist` (lines 101-165) with:

```typescript
export async function solveAssist(
  messages: ChatMessage[],
  model?: string,
  provider?: ModelProvider,
): Promise<SolveAssistResult> {
  const resolvedProvider = provider ?? defaultProvider();

  let text: string;
  let modelId: string;
  let usage: SolveAssistResult["usage"];
  let requestBody: unknown;
  let responseId: string | undefined;
  let responseHeaders: Record<string, string> | undefined;
  let responseBody: unknown;
  const startTime = Date.now();
  let latencyMs: number;

  try {
    const result = await generateText({
      model: getModel(resolvedProvider, model),
      messages,
      temperature: SOLVE_ASSIST_TEMPERATURE,
    });
    latencyMs = Date.now() - startTime;
    text = result.text;
    modelId = result.response.modelId;
    requestBody = result.request.body;
    responseId = result.response.id;
    responseHeaders = result.response.headers;
    responseBody = result.response.body;

    if (result.usage) {
      const u: LanguageModelUsage = result.usage;
      usage = {
        promptTokens: u.inputTokens,
        completionTokens: u.outputTokens,
        totalTokens: u.totalTokens,
      };
    }
  } catch (err) {
    throw classifyModelCallError(err, {
      model: getModelName(resolvedProvider, model),
      latencyMs: Date.now() - startTime,
    });
  }

  // 1. Extract proposals (Reasoning + Words) from the ### GROUPS section
  const proposals = parseGroupProposals(text);

  // 2. Parse final ANSWER section lines
  let groups = parseAnswerGroups(text);

  // 3. Fallback: If parseAnswerGroups failed due to markdown formatting in ### ANSWER,
  //    use the valid word lists extracted from the ### GROUPS block instead
  if (groups.length === 0 && proposals.length > 0) {
    groups = proposals.map((p) => p.words);
  }

  // 4. Reject only if BOTH extraction strategies failed to produce valid 4-word groups
  if (groups.length === 0) {
    throw new SolveError(
      "invalid_group",
      'Model response contained no parseable group proposals or "ANSWER:" section',
      { model: modelId, latencyMs, requestBody, responseId, responseHeaders, responseBody },
    );
  }

  return {
    response: text,
    groups,
    proposals,
    model: modelId,
    latencyMs,
    usage,
    requestBody,
    responseId,
    responseHeaders,
    responseBody,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd orchestrator && npx vitest run src/solve-assist.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full orchestrator test suite to check for regressions**

Run: `cd orchestrator && npx vitest run`
Expected: PASS (in particular `assist.test.ts`, which shares `classifyModelCallError` via `runAssistStep` — its `NoObjectGeneratedError`/`JSONParseError`/generic-`Error` cases are unaffected by the new `APICallError` branch)

- [ ] **Step 7: Commit**

```bash
git add orchestrator/src/solver.ts orchestrator/src/solve-assist.ts orchestrator/src/solve-assist.test.ts
git commit -m "feat: capture raw OpenAI request/response detail in the orchestrator"
```

---

### Task 2: Backend collects raw detail and every retried attempt

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts`
- Test: `backend/src/modules/strategy/orchestrator.service.spec.ts`

**Interfaces:**
- Consumes: the orchestrator's `/solve-assist` JSON bodies now carry `requestBody`/`responseId`/`responseHeaders`/`responseBody` on success, and the same fields plus `statusCode`/`errorName`/`isRetryable` nested under `details` on a `SolveError`-driven error response (from Task 1).
- Produces: `SolveAssistSuccess` and `SolveAssistFailure` each gain `requestBody?: unknown`, `responseId?: string`, `responseHeaders?: Record<string, string>`, `responseBody?: unknown`, and `retriedAttempts?: OpenAiCallAttempt[]` (the earlier attempts within this call that failed and got retried, in order). `SolveAssistFailure` additionally gains `statusCode?: number`, `errorName?: string`, `isRetryable?: boolean`. New exported interface `OpenAiCallAttempt`. `solveAssist()`'s own signature and `SolveAssistOutcome`'s `{ok:true,data}|{ok:false,error}` shape are unchanged — see the Interface Note above.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/modules/strategy/orchestrator.service.spec.ts`, inside the existing `describe("OrchestratorService", ...)` block (after the existing `successBody`/`mockResponse` declarations, alongside the existing `it(...)` cases):

```typescript
  it("should include the raw request/response detail on a 200", async () => {
    const successBodyWithDetail = {
      ...successBody,
      requestBody: { model: "gpt-4.1-nano", messages },
      responseId: "resp_123",
      responseHeaders: { "x-request-id": "req_123" },
      responseBody: { id: "resp_123", choices: [] },
    };
    mockFetch.mockResolvedValueOnce(
      mockResponse({ ok: true, status: 200, body: successBodyWithDetail }),
    );

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({ ok: true, data: successBodyWithDetail });
  });

  it("should surface the raw call detail from a terminal 400/409 error's details bag", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        body: {
          error: "malformed",
          code: "invalid_group",
          details: {
            requestBody: { model: "gpt-4.1-nano" },
            responseId: "resp_456",
            responseHeaders: { "x-request-id": "req_456" },
            responseBody: { id: "resp_456", choices: [] },
          },
        },
      }),
    );

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({
      ok: false,
      error: {
        error: "malformed",
        code: "invalid_group",
        requestBody: { model: "gpt-4.1-nano" },
        responseId: "resp_456",
        responseHeaders: { "x-request-id": "req_456" },
        responseBody: { id: "resp_456", choices: [] },
        retriedAttempts: undefined,
      },
    });
  });

  it("should record each failed 5xx attempt as a retried attempt before eventually succeeding", async () => {
    mockFetch
      .mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 502,
          statusText: "Bad Gateway",
          body: {
            error: "model down",
            code: "model_error",
            details: { statusCode: 502, errorName: "AI_APICallError", isRetryable: true },
          },
        }),
      )
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, body: successBody }));

    const outcome = await service.solveAssist(messages);

    expect(outcome).toEqual({
      ok: true,
      data: {
        ...successBody,
        retriedAttempts: [
          {
            attemptNumber: 1,
            errorMessage: "model down",
            statusCode: 502,
            errorName: "AI_APICallError",
            isRetryable: true,
            requestBody: undefined,
            responseId: undefined,
            responseHeaders: undefined,
            responseBody: undefined,
          },
        ],
      },
    });
  });

  it("should record every attempt when retries are exhausted", async () => {
    mockFetch.mockResolvedValue(
      mockResponse({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        body: { error: "model down", code: "model_error" },
      }),
    );

    const outcome = await service.solveAssist(messages);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.retriedAttempts).toHaveLength(4);
      expect(outcome.error.retriedAttempts?.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4]);
    }
  });
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd backend && npx jest orchestrator.service.spec.ts`
Expected: FAIL — `SolveAssistSuccess`/`SolveAssistFailure` don't carry the new fields yet, and `executeWithRetry` doesn't parse 5xx bodies or track `retriedAttempts`.

- [ ] **Step 3: Update `backend/src/modules/strategy/orchestrator.service.ts`**

Replace lines 4-33 (the type/interface block) with:

```typescript
export type SolveErrorCode = "duplicate_group" | "invalid_group" | "model_error";

export interface SolveUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * One real call attempt to OpenAI that failed and got retried before this
 * request's outcome (success or terminal failure) was reached. Previously
 * these left no trace at all — only the last attempt's bare error message
 * survived. `attemptNumber` is 1-based within this OrchestratorService call.
 */
export interface OpenAiCallAttempt {
  attemptNumber: number;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  statusCode?: number;
  errorName?: string;
  errorMessage?: string;
  isRetryable?: boolean;
}

export interface SolveAssistSuccess {
  response: string;
  groups: string[][];
  model: string;
  latencyMs: number;
  usage?: SolveUsage;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  retriedAttempts?: OpenAiCallAttempt[];
}

export interface SolveAssistFailure {
  error: string;
  code: SolveErrorCode;
  requestBody?: unknown;
  responseId?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  statusCode?: number;
  errorName?: string;
  isRetryable?: boolean;
  retriedAttempts?: OpenAiCallAttempt[];
}

export type SolveAssistOutcome =
  | { ok: true; data: SolveAssistSuccess }
  | { ok: false; error: SolveAssistFailure };
```

Replace the `solveAssist` method (lines 61-77) with:

```typescript
  async solveAssist(
    messages: ChatMessage[],
    model?: string,
    provider?: "openai" | "ollama",
  ): Promise<SolveAssistOutcome> {
    return this.executeWithRetry<SolveAssistSuccess>(
      "/solve-assist",
      { messages, model, provider },
      (raw) => ({
        response: raw.response,
        groups: raw.groups,
        model: raw.model,
        latencyMs: raw.latencyMs ?? 0,
        usage: raw.usage,
        requestBody: raw.requestBody,
        responseId: raw.responseId,
        responseHeaders: raw.responseHeaders,
        responseBody: raw.responseBody,
      }),
    );
  }
```

Replace the `executeWithRetry` method (lines 86-145) with:

```typescript
  private async executeWithRetry<T>(
    path: string,
    body: unknown,
    mapSuccess: (raw: any) => T, // eslint-disable-line @typescript-eslint/no-explicit-any
  ): Promise<{ ok: true; data: T } | { ok: false; error: SolveAssistFailure }> {
    let lastError: unknown;
    const retriedAttempts: OpenAiCallAttempt[] = [];

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.fetchOnce(path, body);

        if (response.ok) {
          const raw = await response.json();
          const data = mapSuccess(raw) as T & { retriedAttempts?: OpenAiCallAttempt[] };
          if (retriedAttempts.length > 0) {
            data.retriedAttempts = retriedAttempts;
          }
          return { ok: true, data };
        }

        const failureBody = (await response.json().catch(() => null)) as
          | (Partial<SolveAssistFailure> & { code?: string; details?: Record<string, unknown> })
          | null;

        if (response.status === 400 || response.status === 409) {
          return {
            ok: false,
            error: {
              error: failureBody?.error ?? `HTTP ${response.status}`,
              code: this.isKnownErrorCode(failureBody?.code) ? failureBody.code : "model_error",
              ...this.extractCallDetail(failureBody?.details),
              retriedAttempts: retriedAttempts.length > 0 ? retriedAttempts : undefined,
            },
          };
        }

        lastError = new Error(`HTTP ${response.status} ${response.statusText}`);
        retriedAttempts.push({
          attemptNumber: attempt + 1,
          errorMessage: failureBody?.error ?? this.describeError(lastError),
          statusCode: response.status,
          ...this.extractCallDetail(failureBody?.details),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return {
            ok: false,
            error: {
              error: "Request timed out",
              code: "model_error",
              retriedAttempts: retriedAttempts.length > 0 ? retriedAttempts : undefined,
            },
          };
        }
        lastError = err;
        retriedAttempts.push({
          attemptNumber: attempt + 1,
          errorMessage: this.describeError(err),
        });
      }

      if (attempt < MAX_RETRIES) {
        const delay = INITIAL_DELAY_MS * 2 ** attempt;
        this.logger.warn(
          `Orchestrator ${path} attempt ${attempt + 1} of ${MAX_RETRIES + 1} failed` +
            ` (${this.describeError(lastError)}). Retrying in ${delay}ms...`,
        );
        await this.sleep(delay);
      }
    }

    return {
      ok: false,
      error: {
        error: `Orchestrator ${path} failed after ${MAX_RETRIES + 1} attempts: ${this.describeError(lastError)}`,
        code: "model_error",
        retriedAttempts,
      },
    };
  }

  /** Pulls the known raw-detail keys off a SolveError `details` bag (see solver.ts on the orchestrator side), ignoring anything else it might carry. */
  private extractCallDetail(
    details?: Record<string, unknown>,
  ): Pick<
    OpenAiCallAttempt,
    | "requestBody"
    | "responseId"
    | "responseHeaders"
    | "responseBody"
    | "statusCode"
    | "errorName"
    | "isRetryable"
  > {
    if (!details) return {};
    return {
      requestBody: details.requestBody,
      responseId: details.responseId as string | undefined,
      responseHeaders: details.responseHeaders as Record<string, string> | undefined,
      responseBody: details.responseBody,
      statusCode: details.statusCode as number | undefined,
      errorName: details.errorName as string | undefined,
      isRetryable: details.isRetryable as boolean | undefined,
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx jest orchestrator.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "feat: collect every retried OpenAI call attempt and raw call detail"
```

---

### Task 3: SolvePrompt schema — new columns and migration

**Files:**
- Modify: `backend/src/modules/strategy/entities/solve-prompt.entity.ts`
- Create: `backend/src/migrations/1767000000000-add-solve-prompt-call-detail.ts`

**Interfaces:**
- Consumes: nothing (pure schema change).
- Produces: `SolvePrompt` entity gains `attemptNumber: number` (default 1), `requestBody: unknown | null`, `responseId: string | null`, `responseHeaders: Record<string, string> | null`, `responseBody: unknown | null`, `statusCode: number | null`, `errorName: string | null`, `errorMessage: string | null`, `isRetryable: boolean | null`. `SolvePromptStatus` gains `CALL_ERROR = "callError"`. Task 5 depends on these exact property names.

- [ ] **Step 1: Update `backend/src/modules/strategy/entities/solve-prompt.entity.ts`**

Replace the `SolvePromptStatus` enum (lines 17-22):

```typescript
export enum SolvePromptStatus {
  PARSED = "parsed",
  MALFORMED_NO_ANSWER_BLOCK = "malformedNoAnswerBlock",
  MALFORMED_GROUP_COUNT = "malformedGroupCount",
  MALFORMED_OTHER = "malformedOther",
  // The OpenAI call itself never produced usable model text — either an
  // earlier attempt this step's backend retry loop discarded, or the step's
  // own terminal failure. rawResponseText stays null for these rows; the
  // request/response/error columns below carry whatever raw detail the
  // orchestrator captured instead.
  CALL_ERROR = "callError",
}
```

Insert the new columns right after the `wordsHadParenthetical` column (after line 73, before the `// ── Per-prompt LLM telemetry ──` comment on line 75):

```typescript
  // 1-based within promptNumber's step — distinguishes an OpenAI call the
  // backend had to retry (orchestrator.service.ts) from the step's other
  // attempts, all of which share the same promptNumber.
  @Column({ type: "int", default: 1 })
  attemptNumber: number;

  // ── Raw OpenAI call detail (populated on every attempt, not just the
  // step's eventual outcome — see llm-strategy-runner.service.ts) ────────

  @Column({ type: "jsonb", nullable: true })
  requestBody: unknown | null;

  @Column({ type: "text", nullable: true })
  responseId: string | null;

  @Column({ type: "jsonb", nullable: true })
  responseHeaders: Record<string, string> | null;

  @Column({ type: "jsonb", nullable: true })
  responseBody: unknown | null;

  @Column({ type: "int", nullable: true })
  statusCode: number | null;

  @Column({ type: "text", nullable: true })
  errorName: string | null;

  @Column({ type: "text", nullable: true })
  errorMessage: string | null;

  @Column({ type: "boolean", nullable: true })
  isRetryable: boolean | null;

```

- [ ] **Step 2: Create the migration**

Create `backend/src/migrations/1767000000000-add-solve-prompt-call-detail.ts`:

```typescript
import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds raw OpenAI call-detail columns to SolvePrompt and a new CALL_ERROR
 * status, so a strategy-run OpenAI call that fails (or gets retried and
 * fails before eventually succeeding) leaves a row instead of vanishing —
 * see docs/superpowers/specs/2026-08-21-openai-call-logging-design.md.
 */
export class AddSolvePromptCallDetail1767000000000 implements MigrationInterface {
  name = "AddSolvePromptCallDetail1767000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "solve_prompt_status_enum" ADD VALUE 'callError'`);

    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN "requestBody" JSONB,
      ADD COLUMN "responseId" TEXT,
      ADD COLUMN "responseHeaders" JSONB,
      ADD COLUMN "responseBody" JSONB,
      ADD COLUMN "statusCode" INTEGER,
      ADD COLUMN "errorName" TEXT,
      ADD COLUMN "errorMessage" TEXT,
      ADD COLUMN "isRetryable" BOOLEAN
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "SolvePrompt"
      DROP COLUMN "attemptNumber",
      DROP COLUMN "requestBody",
      DROP COLUMN "responseId",
      DROP COLUMN "responseHeaders",
      DROP COLUMN "responseBody",
      DROP COLUMN "statusCode",
      DROP COLUMN "errorName",
      DROP COLUMN "errorMessage",
      DROP COLUMN "isRetryable"
    `);
    // Postgres has no "remove enum value" operation short of recreating the
    // type (rename it, create a replacement without the value, repoint the
    // column, drop the old type) — this migration doesn't attempt that.
    // Rolling back leaves 'callError' a valid-but-unused status value,
    // which is harmless.
  }
}
```

- [ ] **Step 3: Run the migration against the local dev database**

Run: `cd backend && npm run migration:run`
Expected: Migration `AddSolvePromptCallDetail1767000000000` applies cleanly with no errors.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/strategy/entities/solve-prompt.entity.ts backend/src/migrations/1767000000000-add-solve-prompt-call-detail.ts
git commit -m "feat: add raw OpenAI call-detail columns to SolvePrompt"
```

---

### Task 4: StrategyRunStore resumes numbering by MAX, not COUNT

**Why this task exists:** `LlmStrategyRunner.runLlmStrategy` resumes a restarted run by asking `StrategyRunStore` how many `SolvePrompt` rows already exist, then numbering subsequent steps from there (`globalPromptNumber`). Today exactly one row is written per *successful* step, so a row count and "how many steps have happened" are the same number. After Task 5, multiple rows can share one `promptNumber` (an earlier retried-and-failed attempt plus the step's final row), so a raw row count would over-count and desynchronize the numbering on a resumed run. The fix is to resume from the highest `promptNumber` already recorded instead of a row count — the two happen to agree today, but only the MAX-based version stays correct once one step can produce more than one row.

**Files:**
- Modify: `backend/src/modules/strategy/strategy-run-store.service.ts`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts:216` (the one call site)
- Test: `backend/src/modules/strategy/strategy-run-store.service.spec.ts`
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts` (mock setup only — see Task 5, which touches this file's assertions too; both tasks' edits to this file are combined into the single edit described in Task 5 Step 1 to avoid two passes over the same file)

**Interfaces:**
- Consumes: nothing new.
- Produces: `StrategyRunStore.lastPromptNumber(strategyRunId: number): Promise<number>` replaces `countPrompts`. Returns the highest `promptNumber` recorded for the run, or `0` if none exist yet — a drop-in replacement for how `countPrompts`'s return value was already being used (`let globalPromptNumber = await this.store.countPrompts(run.id)`).

- [ ] **Step 1: Write the failing test**

Replace the `describe("countPrompts", ...)` block (lines 191-202) in `backend/src/modules/strategy/strategy-run-store.service.spec.ts` with:

```typescript
  describe("lastPromptNumber", () => {
    it("should return the highest promptNumber recorded for the strategy run", async () => {
      const getRawOne = jest.fn().mockResolvedValueOnce({ max: "5" });
      const where = jest.fn().mockReturnValue({ getRawOne });
      const select = jest.fn().mockReturnValue({ where });
      mockSolvePromptRepo.createQueryBuilder.mockReturnValueOnce({ select });

      const result = await store.lastPromptNumber(7);

      expect(result).toBe(5);
      expect(where).toHaveBeenCalledWith("prompt.strategyRunId = :strategyRunId", { strategyRunId: 7 });
    });

    it("should return 0 when the strategy run has no prompts yet", async () => {
      const getRawOne = jest.fn().mockResolvedValueOnce({ max: null });
      const where = jest.fn().mockReturnValue({ getRawOne });
      const select = jest.fn().mockReturnValue({ where });
      mockSolvePromptRepo.createQueryBuilder.mockReturnValueOnce({ select });

      const result = await store.lastPromptNumber(7);

      expect(result).toBe(0);
    });
  });
```

Also replace the `mockSolvePromptRepo` declaration (line 21) and its `beforeEach` initialization (line 51-53):

```typescript
  let mockSolvePromptRepo: { createQueryBuilder: jest.Mock };
```

```typescript
    mockSolvePromptRepo = {
      createQueryBuilder: jest.fn(),
    };
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest strategy-run-store.service.spec.ts`
Expected: FAIL — `store.lastPromptNumber` doesn't exist yet (TypeScript compile error / `TypeError: store.lastPromptNumber is not a function`).

- [ ] **Step 3: Update `backend/src/modules/strategy/strategy-run-store.service.ts`**

Replace the `countPrompts` method (lines 115-119) with:

```typescript
  /**
   * The highest promptNumber already recorded for this run, or 0 if none
   * exist yet. Used to resume numbering after a worker restart. A MAX
   * rather than a row COUNT because a single step can now produce more
   * than one SolvePrompt row (an earlier failed-and-retried OpenAI call
   * attempt plus the step's own final row — see llm-strategy-runner.service.ts),
   * all sharing that step's promptNumber.
   */
  async lastPromptNumber(strategyRunId: number): Promise<number> {
    const result = await this.solvePromptRepo
      .createQueryBuilder("prompt")
      .select('MAX(prompt."promptNumber")', "max")
      .where("prompt.strategyRunId = :strategyRunId", { strategyRunId })
      .getRawOne<{ max: string | null }>();
    return Number(result?.max ?? 0);
  }
```

- [ ] **Step 4: Update the one call site**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts:216`, change:

```typescript
    let globalPromptNumber = await this.store.countPrompts(run.id);
```

to:

```typescript
    let globalPromptNumber = await this.store.lastPromptNumber(run.id);
```

- [ ] **Step 5: Update `llm-strategy-runner.service.spec.ts`'s mock so its tests keep compiling and passing**

Replace the `mockSolvePromptRepo` type declaration (lines 25-27) and its `beforeEach` initialization (lines 75-77):

```typescript
  let mockSolvePromptRepo: { createQueryBuilder: jest.Mock };
```

```typescript
    mockSolvePromptRepo = {
      createQueryBuilder: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ max: null }),
      }),
    };
```

This gives every existing test in that file the same effective default `lastPromptNumber` resumed from had before (`0`), so none of their `promptNumber`-sequencing assertions change.

- [ ] **Step 6: Run both spec files to verify everything passes**

Run: `cd backend && npx jest strategy-run-store.service.spec.ts llm-strategy-runner.service.spec.ts`
Expected: PASS (the `llm-strategy-runner.service.spec.ts` run at this point only proves the mock change didn't break anything — Task 5 below is what actually changes that file's production-code-facing behavior)

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/strategy-run-store.service.ts backend/src/modules/strategy/strategy-run-store.service.spec.ts backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "refactor: resume SolvePrompt numbering from MAX(promptNumber) instead of a row count"
```

---

### Task 5: LlmStrategyRunner writes one SolvePrompt row per attempt

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Test: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `SolveAssistOutcome`'s new `retriedAttempts`/raw-detail fields from Task 2; `SolvePrompt`'s new `attemptNumber`/raw-detail columns and `SolvePromptStatus.CALL_ERROR` from Task 3; `StrategyRunStore.lastPromptNumber` from Task 4.
- Produces: every OpenAI call attempt in a solve step — retried failures and the step's final outcome, success or terminal failure alike — becomes one `Partial<SolvePrompt>` pushed onto `pendingPrompts`, all sharing the step's `promptNumber` and each with its own `attemptNumber`. This is a real behavior change from today (where a failed step wrote zero rows), so three existing tests' "no row was written" assertions must be updated to match, not just three new tests added. A new private `toJsonbResponseBody` helper guards every `responseBody` write (see Step 4) — required because that source's raw value is an object on success but a possibly-non-JSON string on failure (`APICallError.responseBody`), and the column is `jsonb`.

- [ ] **Step 1: Update the three existing tests whose assertions the new behavior invalidates**

In `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`:

Replace the body of `"should terminate with 'duplicate' once the duplicate limit is hit"` (around line 421-423) — the two lines:

```typescript
        expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(3);
        expect(mockManager.insert).not.toHaveBeenCalled();
```

become:

```typescript
        expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(3);
        // Every failed call now gets its own CALL_ERROR SolvePrompt row —
        // previously a duplicate_group failure left no trace at all.
        const promptRows = mockManager.insert.mock.calls
          .filter((call) => call[0] === "SolvePrompt")
          .flatMap((call) => call[1] as Array<Record<string, unknown>>);
        expect(promptRows).toHaveLength(3);
        expect(promptRows.every((row) => row.status === "callError")).toBe(true);
        expect(mockManager.insert).not.toHaveBeenCalledWith("Guess", expect.anything());
```

Replace the body of `"should terminate with 'malformedResponse' after consecutive invalid responses"` (around line 533-534) — the two lines:

```typescript
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(3);
      expect(mockManager.insert).not.toHaveBeenCalled();
```

become:

```typescript
      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(3);
      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows).toHaveLength(3);
      expect(promptRows.every((row) => row.status === "callError")).toBe(true);
      expect(mockManager.insert).not.toHaveBeenCalledWith("Guess", expect.anything());
```

Replace the body of `"should terminate with 'error' only after max consecutive model errors"` (around line 577-578) — the two lines:

```typescript
        expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(2);
        expect(mockManager.insert).not.toHaveBeenCalled();
```

become:

```typescript
        expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(2);
        const promptRows = mockManager.insert.mock.calls
          .filter((call) => call[0] === "SolvePrompt")
          .flatMap((call) => call[1] as Array<Record<string, unknown>>);
        expect(promptRows).toHaveLength(2);
        expect(promptRows.every((row) => row.status === "callError")).toBe(true);
        expect(mockManager.insert).not.toHaveBeenCalledWith("Guess", expect.anything());
```

- [ ] **Step 2: Write new failing tests for the new behavior**

Add to the same `describe("runLlmStrategy", ...)` block:

```typescript
    it("should write a CALL_ERROR row for a terminal failure, carrying whatever raw detail the orchestrator returned", async () => {
      mockOrchestratorService.solveAssist.mockResolvedValue({
        ok: false,
        error: {
          error: "model down",
          code: "model_error",
          statusCode: 502,
          errorName: "AI_APICallError",
          isRetryable: true,
        },
      });

      await runner.runLlmStrategy(100, "llm-openai");

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(
        expect.objectContaining({
          status: "callError",
          attemptNumber: 1,
          statusCode: 502,
          errorName: "AI_APICallError",
          errorMessage: "model down",
          isRetryable: true,
        }),
      );
    });

    it("should write one row per retried attempt plus the successful final attempt, all sharing the step's promptNumber", async () => {
      mockOrchestratorService.solveAssist.mockResolvedValueOnce({
        ok: true,
        data: {
          response: "### ANSWER\nAPPLE, BANANA, CHERRY, DATE",
          groups: [["APPLE", "BANANA", "CHERRY", "DATE"]],
          model: "mistral",
          latencyMs: 500,
          retriedAttempts: [
            { attemptNumber: 1, errorMessage: "model down", statusCode: 502 },
          ],
        },
      });
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
      );

      await runner.runLlmStrategy(100, "llm-openai");

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);

      // Step 1 produced 2 rows (the retried failure + the eventual success),
      // step 2 produced 1 — 3 total.
      expect(promptRows).toHaveLength(3);
      expect(promptRows[0]).toEqual(
        expect.objectContaining({ promptNumber: 1, attemptNumber: 1, status: "callError" }),
      );
      expect(promptRows[1]).toEqual(
        expect.objectContaining({ promptNumber: 1, attemptNumber: 2, status: "parsed" }),
      );
      expect(promptRows[2]).toEqual(
        expect.objectContaining({ promptNumber: 2, attemptNumber: 1, status: "parsed" }),
      );
    });

    it("should persist requestBody/responseId/responseHeaders/responseBody on the successful row", async () => {
      mockOrchestratorService.solveAssist.mockResolvedValueOnce({
        ok: true,
        data: {
          response: "### ANSWER\nAPPLE, BANANA, CHERRY, DATE",
          groups: [["APPLE", "BANANA", "CHERRY", "DATE"]],
          model: "mistral",
          latencyMs: 500,
          requestBody: { model: "mistral" },
          responseId: "resp_789",
          responseHeaders: { "x-request-id": "req_789" },
          responseBody: { id: "resp_789" },
        },
      });
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([["EGGPLANT", "FIG", "GRAPE", "HONEY"]]),
      );

      await runner.runLlmStrategy(100, "llm-openai");

      const promptRows = mockManager.insert.mock.calls
        .filter((call) => call[0] === "SolvePrompt")
        .flatMap((call) => call[1] as Array<Record<string, unknown>>);
      expect(promptRows[0]).toEqual(
        expect.objectContaining({
          requestBody: { model: "mistral" },
          responseId: "resp_789",
          responseHeaders: { "x-request-id": "req_789" },
          responseBody: { id: "resp_789" },
        }),
      );
    });

    it("should parse a string responseBody into JSON when writing a CALL_ERROR row, and fall back to the raw string when it isn't valid JSON", async () => {
      jest
        .spyOn(runner as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);
      process.env.LLM_MAX_MODEL_ERRORS = "2";
      try {
        mockOrchestratorService.solveAssist
          .mockResolvedValueOnce({
            ok: false,
            error: {
              error: "rate limited",
              code: "model_error",
              responseBody: '{"error":{"message":"Rate limit exceeded"}}',
            },
          })
          .mockResolvedValueOnce({
            ok: false,
            error: {
              error: "gateway error",
              code: "model_error",
              responseBody: "<html>502 Bad Gateway</html>",
            },
          });

        await runner.runLlmStrategy(100, "llm-openai");

        const promptRows = mockManager.insert.mock.calls
          .filter((call) => call[0] === "SolvePrompt")
          .flatMap((call) => call[1] as Array<Record<string, unknown>>);
        expect(promptRows[0].responseBody).toEqual({ error: { message: "Rate limit exceeded" } });
        expect(promptRows[1].responseBody).toBe("<html>502 Bad Gateway</html>");
      } finally {
        delete process.env.LLM_MAX_MODEL_ERRORS;
      }
    });
```

- [ ] **Step 3: Run the tests to verify the new ones fail and the three updated ones still fail against old code**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: FAIL — production code doesn't write `attemptNumber`/raw-detail columns yet, and failed outcomes still write zero rows.

- [ ] **Step 4: Update `backend/src/modules/strategy/llm-strategy-runner.service.ts`**

Replace lines 210-311 (from `// Conversation history...` through the `flushBatch` call at the end of the loop body) with:

```typescript
    // Conversation history for the AI Assist prompt flow.
    const messages: ChatMessage[] = [];

    const pendingGuesses: Partial<Guess>[] = [];
    const pendingProposals: Partial<LlmProposal>[] = [];
    const pendingPrompts: Partial<SolvePrompt>[] = [];
    let globalPromptNumber = await this.store.lastPromptNumber(run.id);

    while (true) {
      const N = run.availableWords.length / GROUP_SIZE;

      // Build the prompt for this step.
      const prompt = state.lastFailedGuess
        ? buildRetryPrompt(run.availableWords, state.lockedInGroups, state.lastFailedGuess, N)
        : buildInitialPrompt(run.availableWords, N);

      // Append the user message to conversation history.
      messages.push({ role: "user", content: prompt });

      const outcome = await this.orchestratorService.solveAssist(messages, model, provider);

      // One promptNumber per loop iteration regardless of outcome, so a
      // step's earlier failed-and-retried OpenAI calls (below) and its
      // final row all record under the same step number.
      globalPromptNumber++;
      const promptType = state.lastFailedGuess
        ? SolvePromptType.RETRY
        : SolvePromptType.INITIAL_SOLVE;

      // Record every OpenAI call attempt that failed and got retried before
      // this iteration's final outcome — previously discarded entirely, now
      // each gets its own row so a flaky OpenAI call leaves a trace.
      const retriedAttempts = outcome.ok
        ? outcome.data.retriedAttempts
        : outcome.error.retriedAttempts;
      for (const attempt of retriedAttempts ?? []) {
        pendingPrompts.push(
          this.buildCallErrorPromptRow(run.id, globalPromptNumber, promptType, attempt),
        );
      }
      const finalAttemptNumber = (retriedAttempts?.length ?? 0) + 1;

      if (outcome.ok) {
        const data = outcome.data;
        state.consecutiveModelErrors = 0;

        // Set run-level model metadata from the first successful call.
        if (run.modelName === null) {
          run.modelName = data.model;
        }

        // Append the assistant response to conversation history.
        messages.push({ role: "assistant", content: data.response });

        // Create a SolvePrompt row for this LLM call.
        const currentPrompt: Partial<SolvePrompt> = {
          strategyRunId: run.id,
          promptNumber: globalPromptNumber,
          attemptNumber: finalAttemptNumber,
          promptType,
          status: SolvePromptStatus.PARSED,
          rawResponseText: data.response,
          wordsHadParenthetical: false,
          temperature,
          promptTokens: data.usage?.promptTokens ?? null,
          completionTokens: data.usage?.completionTokens ?? null,
          totalTokens: data.usage?.totalTokens ?? null,
          latencyMs: data.latencyMs,
          requestBody: data.requestBody ?? null,
          responseId: data.responseId ?? null,
          responseHeaders: data.responseHeaders ?? null,
          responseBody: this.toJsonbResponseBody(data.responseBody),
        };
        pendingPrompts.push(currentPrompt);

        const groups = data.groups;
        if (groups.length === 0) {
          // currentPrompt is the same object already queued in pendingPrompts,
          // so mutating it here still reflects at flush time.
          currentPrompt.status = SolvePromptStatus.MALFORMED_NO_ANSWER_BLOCK;
          state.malformedCount++;
          if (state.malformedCount >= maxMalformed) {
            run.status = StrategyRunStatus.MALFORMED_RESPONSE;
            run.finishedAt = new Date();
          }
        } else {
          const { proposalWords, categoryMap, hadParenthetical } = this.parseGroupsSection(
            data.response ?? "",
            groups,
          );
          // currentPrompt is the same object already queued in
          // pendingPrompts, so mutating it here still reflects at flush time.
          currentPrompt.wordsHadParenthetical = hadParenthetical;

          const proposalEntries = this.buildProposalEntries(
            proposalWords,
            categoryMap,
            run,
            currentPrompt,
          );
          pendingProposals.push(...proposalEntries);

          this.evaluateProposals(
            proposalEntries,
            run,
            puzzle,
            puzzleId,
            state,
            pendingGuesses,
            maxDuplicates,
            maxFailedGuesses,
          );
        }
      } else {
        // The prompt was already pushed as a user turn before this call; the
        // call failed with no assistant reply, so drop it rather than let
        // the next retry stack a second consecutive user turn on top of it.
        messages.pop();

        // The step's terminal failure gets its own row too — previously
        // this outcome left zero trace in the database.
        pendingPrompts.push(
          this.buildCallErrorPromptRow(run.id, globalPromptNumber, promptType, {
            attemptNumber: finalAttemptNumber,
            requestBody: outcome.error.requestBody,
            responseId: outcome.error.responseId,
            responseHeaders: outcome.error.responseHeaders,
            responseBody: outcome.error.responseBody,
            statusCode: outcome.error.statusCode,
            errorName: outcome.error.errorName,
            errorMessage: outcome.error.error,
            isRetryable: outcome.error.isRetryable,
          }),
        );

        this.classifyFailedCall(outcome.error.code, run, state, maxModelErrors, maxDuplicates, maxMalformed);
      }

      // Flush every iteration.
      await this.store.flushBatch(run, pendingGuesses, pendingProposals, pendingPrompts);
```

(the remainder of the method — the backoff/status-check/return block right after — is unchanged)

Add a new private helper method, placed right after `runLlmStrategy` (before `parseGroupsSection`):

```typescript
  /**
   * Builds a SolvePrompt row for an OpenAI call attempt that never produced
   * usable model text — either an earlier attempt this step's backend retry
   * loop discarded, or the step's own terminal failure. Carries whatever
   * raw request/response detail the orchestrator captured, so a failed call
   * still leaves enough to diagnose it (previously these left no row at
   * all — see orchestrator.service.ts and solver.ts).
   */
  private buildCallErrorPromptRow(
    strategyRunId: number,
    promptNumber: number,
    promptType: SolvePromptType,
    attempt: {
      attemptNumber: number;
      requestBody?: unknown;
      responseId?: string;
      responseHeaders?: Record<string, string>;
      responseBody?: unknown;
      statusCode?: number;
      errorName?: string;
      errorMessage?: string;
      isRetryable?: boolean;
    },
  ): Partial<SolvePrompt> {
    return {
      strategyRunId,
      promptNumber,
      attemptNumber: attempt.attemptNumber,
      promptType,
      status: SolvePromptStatus.CALL_ERROR,
      requestBody: attempt.requestBody ?? null,
      responseId: attempt.responseId ?? null,
      responseHeaders: attempt.responseHeaders ?? null,
      responseBody: this.toJsonbResponseBody(attempt.responseBody),
      statusCode: attempt.statusCode ?? null,
      errorName: attempt.errorName ?? null,
      errorMessage: attempt.errorMessage ?? null,
      isRetryable: attempt.isRetryable ?? null,
    };
  }

  /**
   * `responseBody` is a `jsonb` column, which requires a valid JSON value.
   * On success it's always an object (AI SDK gives back the parsed OpenAI
   * response). On failure it's `APICallError.responseBody` — a raw string
   * with no guarantee of being valid JSON (could be a gateway HTML error
   * page, plain text, etc). Parse it when possible so the column stays
   * queryable, since real OpenAI error bodies are JSON; otherwise store the
   * raw string itself, which is still valid jsonb — this never fails to
   * write and never silently drops the original text.
   */
  private toJsonbResponseBody(value: unknown): unknown {
    if (typeof value !== "string") return value ?? null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx jest llm-strategy-runner.service.spec.ts`
Expected: PASS

- [ ] **Step 6: Run the full backend test suite to check for regressions**

Run: `cd backend && npx jest`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "feat: write a SolvePrompt row for every OpenAI call attempt, not just successful steps"
```

---

## Final Verification

- [ ] Run the full orchestrator suite: `cd orchestrator && npx vitest run`
- [ ] Run the full backend suite: `cd backend && npx jest`
- [ ] Run `cd backend && npm run migration:run` then `npm run migration:revert` then `npm run migration:run` again against a scratch DB to confirm both directions execute without error.
- [ ] Skim a few real `SolvePrompt` rows after a local strategy run (including one where you've temporarily broken `OPENAI_API_KEY` to force a real failure) to confirm `attemptNumber`, `status`, and the raw-detail columns look right end to end — the unit tests above cover the code paths individually, but only a real run exercises the actual orchestrator→backend HTTP round trip together.
