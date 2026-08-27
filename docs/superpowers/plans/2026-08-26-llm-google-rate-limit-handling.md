# LLM Google Rate-Limit Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `llm-google` runs onto their own dedicated queue (fixing a routing bug), and make a Google per-minute rate-limit hit (RPM or TPM) wait-and-retry indefinitely instead of counting toward the run's failure threshold — while a daily-quota hit (RPD) still counts as today's `model_error`.

**Architecture:** A new `SolveErrorCode` (`"rate_limited"`) is classified on the orchestrator by parsing Google's real 429 `QuotaFailure`/`RetryInfo` error shape (confirmed via a live spike — see spec), gated to `provider === "google"` only. The backend's existing per-step retry loop (`LlmStrategyRunner`) gains a branch that reacts to this code by waiting the server-specified duration and looping again, without touching any of the counters that would otherwise end the run. Separately, `queueForStrategy` (which already exists for `llm-openai`/`llm-ollama`) gains the missing `llm-google` branch onto the `llm-google-runs` queue `worker.ts` already consumes but nothing enqueues onto.

**Tech Stack:** NestJS + TypeORM + BullMQ + Jest (backend), Hono + Zod + Vercel AI SDK + Vitest (orchestrator).

**Spec:** [docs/superpowers/specs/2026-08-26-llm-google-rate-limit-handling-design.md](../specs/2026-08-26-llm-google-rate-limit-handling-design.md)

## Global Constraints

- No cap on consecutive rate-limit waits — unbounded retry, by explicit decision.
- Real captured Google 429 shape (from the spec) is the ground truth for parsing — do not guess field names.
- `retryAfterSeconds` uses Google's `RetryInfo.retryDelay` when present; falls back to `DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS` (60) only when absent/unparseable.
- This applies to `llm-google` only — `llm-openai`/`llm-ollama` are unaffected.
- Every new piece of logic follows this repo's TDD workflow: failing test first, watch it fail, minimal implementation, watch it pass.
- Backend tests run via `npm test` from `backend/`; orchestrator tests via `npm test` from `orchestrator/`.

---

## Task 1: Backend — fix `llm-google` queue routing

**Files:**
- Modify: `backend/src/modules/queue/strategy.queue.ts`
- Modify: `backend/src/modules/queue/queue.module.ts`
- Modify: `backend/src/modules/strategy/strategy.service.ts`
- Modify: `backend/src/modules/strategy/strategy.service.spec.ts`

**Interfaces:**
- Produces: `llmGoogleQueue` (BullMQ `Queue` named `"llm-google-runs"`). `queueForStrategy(defaultQueue, openAIQueue, ollamaQueue, googleQueue, strategyName)` — gains a fourth queue parameter. `LLM_GOOGLE_QUEUE` DI token, exported from `queue.module.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/modules/strategy/strategy.service.spec.ts`. First, update the import at the top of the file:

```ts
import { STRATEGY_QUEUE, LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, LLM_GOOGLE_QUEUE } from "../queue/queue.module";
```

Add a mock queue declaration next to the existing two (near the top of the `describe` block):

```ts
  let mockGoogleQueue: { add: jest.Mock; addBulk: jest.Mock; getJobs: jest.Mock };
```

In `beforeEach`, add the mock's setup next to `mockOllamaQueue`'s:

```ts
    mockGoogleQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
      getJobs: jest.fn().mockResolvedValue([]),
    };
```

Register it in the `TestingModule`'s `providers` array, next to the other two queue providers:

```ts
        { provide: LLM_GOOGLE_QUEUE, useValue: mockGoogleQueue },
```

Add these two tests, mirroring the existing `llm-openai`/`llm-ollama` routing tests exactly (place the first right after "should route llm-ollama runs to the Ollama queue after validating the model", and the second right after "should queue exactly one new llm-ollama trial on the Ollama queue after validating the model"):

```ts
    it("should route llm-google runs to the Google queue after validating the model", async () => {
      await service.triggerRun(100, "llm-google", "2024-01-02", 0, "gemini-3.6-flash");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-google",
        "gemini-3.6-flash",
      );
      expect(mockGoogleQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-google",
          date: "2024-01-02",
          trialNumber: 0,
          model: "gemini-3.6-flash",
        },
        { jobId: "run-100-llm-google-0" },
      );
      expect(mockQueue.add).not.toHaveBeenCalled();
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
      expect(mockOllamaQueue.add).not.toHaveBeenCalled();
    });
```

```ts
    it("should queue exactly one new llm-google trial on the Google queue after validating the model", async () => {
      mockStrategyRunRepo.find.mockResolvedValueOnce([]);

      await service.triggerStrategyRuns(100, "llm-google", "2024-01-02", "gemini-3.6-flash");

      expect(mockSupportedModelService.assertSupported).toHaveBeenCalledWith(
        "llm-google",
        "gemini-3.6-flash",
      );
      expect(mockStrategyRunRepo.find).toHaveBeenCalledWith({
        where: { puzzleId: 100, strategyName: "llm-google" },
        select: { trialNumber: true, modelName: true },
      });
      expect(mockGoogleQueue.add).toHaveBeenCalledTimes(1);
      expect(mockOpenAIQueue.add).not.toHaveBeenCalled();
      expect(mockOllamaQueue.add).not.toHaveBeenCalled();
      expect(mockGoogleQueue.add).toHaveBeenCalledWith(
        "run-strategy",
        {
          puzzleId: 100,
          strategyName: "llm-google",
          date: "2024-01-02",
          trialNumber: 1,
          model: "gemini-3.6-flash",
        },
        { jobId: "run-100-llm-google-1" },
      );
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- strategy.service.spec.ts`
Expected: FAIL — `LLM_GOOGLE_QUEUE` doesn't exist yet (import/compile error), and once that's stubbed, `mockGoogleQueue.add` is never called (llm-google falls through to the shared `strategyQueue`).

- [ ] **Step 3: Add the queue**

In `backend/src/modules/queue/strategy.queue.ts`:

```ts
import { Queue } from "bullmq";
import { redisConnection } from "./redis.config";
import { LLM_OPENAI, LLM_OLLAMA, LLM_GOOGLE } from "../../strategies";

export const strategyQueue = new Queue("strategy-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/**
 * Per-provider queues for the LLM strategies. Splitting them off the shared
 * strategy-runs queue lets each provider's worker process runs at its own
 * configured concurrency, so llm-openai, llm-ollama, and llm-google runs
 * never block each other — and the deterministic strategies are never
 * delayed behind an LLM call (which can take minutes).
 */
export const llmOpenAIQueue = new Queue("llm-openai-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const llmOllamaQueue = new Queue("llm-ollama-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export const llmGoogleQueue = new Queue("llm-google-runs", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/**
 * Routes a strategy run to the queue that processes it: the three LLM
 * strategies get their per-provider queues, everything else stays on the
 * shared strategy-runs queue. The only place the strategy->queue mapping
 * lives, so enqueue call sites stay provider-agnostic.
 */
export function queueForStrategy(
  defaultQueue: Queue,
  openAIQueue: Queue,
  ollamaQueue: Queue,
  googleQueue: Queue,
  strategyName: string,
): Queue {
  if (strategyName === LLM_OPENAI) return openAIQueue;
  if (strategyName === LLM_OLLAMA) return ollamaQueue;
  if (strategyName === LLM_GOOGLE) return googleQueue;
  return defaultQueue;
}

/**
 * Deterministic job id for a strategy run so that duplicate enqueues of the
 * same (puzzle, strategy, trial) collapse to a single BullMQ job.
 */
export function runStrategyJobId(
  puzzleId: number | string,
  strategyName: string,
  trialNumber: number,
): string {
  return `run-${puzzleId}-${strategyName}-${trialNumber}`;
}
```

- [ ] **Step 4: Register the queue in the module**

In `backend/src/modules/queue/queue.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { strategyQueue, llmOpenAIQueue, llmOllamaQueue, llmGoogleQueue } from "./strategy.queue";
import { puzzleQueue } from "./puzzle.queue";
import { freeTierDispatchQueue } from "./free-tier-dispatch.queue";
import { modelMetadataQueue } from "./model-metadata.queue";

export const STRATEGY_QUEUE = "STRATEGY_QUEUE";
export const LLM_OPENAI_QUEUE = "LLM_OPENAI_QUEUE";
export const LLM_OLLAMA_QUEUE = "LLM_OLLAMA_QUEUE";
export const LLM_GOOGLE_QUEUE = "LLM_GOOGLE_QUEUE";
export const PUZZLE_QUEUE = "PUZZLE_QUEUE";
export const FREE_TIER_DISPATCH_QUEUE = "FREE_TIER_DISPATCH_QUEUE";
export const MODEL_METADATA_QUEUE = "MODEL_METADATA_QUEUE";

@Module({
  providers: [
    { provide: STRATEGY_QUEUE, useValue: strategyQueue },
    { provide: LLM_OPENAI_QUEUE, useValue: llmOpenAIQueue },
    { provide: LLM_OLLAMA_QUEUE, useValue: llmOllamaQueue },
    { provide: LLM_GOOGLE_QUEUE, useValue: llmGoogleQueue },
    { provide: PUZZLE_QUEUE, useValue: puzzleQueue },
    { provide: FREE_TIER_DISPATCH_QUEUE, useValue: freeTierDispatchQueue },
    { provide: MODEL_METADATA_QUEUE, useValue: modelMetadataQueue },
  ],
  exports: [
    STRATEGY_QUEUE,
    LLM_OPENAI_QUEUE,
    LLM_OLLAMA_QUEUE,
    LLM_GOOGLE_QUEUE,
    PUZZLE_QUEUE,
    FREE_TIER_DISPATCH_QUEUE,
    MODEL_METADATA_QUEUE,
  ],
})
export class QueueModule {}
```

- [ ] **Step 5: Wire it into `StrategyService`**

In `backend/src/modules/strategy/strategy.service.ts`, add the import and constructor injection (next to the existing two queue injections):

```ts
import { STRATEGY_QUEUE, LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, LLM_GOOGLE_QUEUE } from "../queue/queue.module";
```

```ts
  constructor(
    @Inject(STRATEGY_QUEUE) private queue: Queue,
    @Inject(LLM_OPENAI_QUEUE) private readonly llmOpenAIQueue: Queue,
    @Inject(LLM_OLLAMA_QUEUE) private readonly llmOllamaQueue: Queue,
    @Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,
    @InjectRepository(StrategyRun)
    private readonly strategyRunRepo: Repository<StrategyRun>,
    @InjectRepository(Puzzle) private readonly puzzleRepo: Repository<Puzzle>,
    @InjectRepository(Guess) private readonly guessRepo: Repository<Guess>,
    @InjectRepository(SolvePrompt) private readonly solvePromptRepo: Repository<SolvePrompt>,
    @InjectRepository(LlmProposal) private readonly llmProposalRepo: Repository<LlmProposal>,
    @Inject(GameService) private readonly gameService: GameService,
    @Inject(StrategyRunStore) private readonly store: StrategyRunStore,
    @Inject(SupportedModelService) private readonly supportedModelService: SupportedModelService,
  ) {}
```

Update `queueFor`:

```ts
  /**
   * The queue a strategy's runs are dispatched to: llm-openai, llm-ollama,
   * and llm-google each get their own per-provider queue, everything else
   * the shared strategy-runs queue.
   */
  private queueFor(strategyName: string): Queue {
    return queueForStrategy(
      this.queue,
      this.llmOpenAIQueue,
      this.llmOllamaQueue,
      this.llmGoogleQueue,
      strategyName,
    );
  }
```

Update `queuedCountsByKey`'s queue list:

```ts
    const queues = [this.queue, this.llmOpenAIQueue, this.llmOllamaQueue, this.llmGoogleQueue];
```

- [ ] **Step 6: Run tests to verify they pass**

Run (from `backend/`): `npm test -- strategy.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 7: Commit**

```bash
git add backend/src/modules/queue/strategy.queue.ts backend/src/modules/queue/queue.module.ts backend/src/modules/strategy/strategy.service.ts backend/src/modules/strategy/strategy.service.spec.ts
git commit -m "fix: route llm-google runs onto their own queue"
```

---

## Task 2: Orchestrator — classify Google's per-minute rate-limit error

**Files:**
- Create: `orchestrator/src/solver.test.ts`
- Modify: `orchestrator/src/solver.ts`
- Modify: `orchestrator/src/types.ts`

**Interfaces:**
- Consumes: `ModelProvider` (from `provider.ts`).
- Produces: `SolveErrorCode` gains `"rate_limited"`. `SolveErrorDetails` gains `retryAfterSeconds?: number`. `classifyModelCallError(err, provider, details)` — gains a `provider: ModelProvider` second parameter (existing `details` param shifts to third).

- [ ] **Step 1: Widen the error code type**

In `orchestrator/src/types.ts`, update `SolveErrorCodeSchema`:

```ts
export const SolveErrorCodeSchema = z.enum([
  "duplicate_group",
  "invalid_group",
  "model_error",
  "rate_limited",
]);
```

- [ ] **Step 2: Write the failing tests**

Create `orchestrator/src/solver.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { APICallError } from "ai";
import { classifyModelCallError, SolveError } from "./solver.js";

// The real 429 body captured from a live burst against Google AI Studio's
// gemini-3.6-flash — see the design spec for how this was obtained. A
// requests-per-minute violation: the quotaId contains "PerMinute".
const GOOGLE_RPM_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. " +
      "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
      "limit: 5, model: gemini-3.6-flash\nPlease retry in 3.857116819s.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.Help",
        links: [{ description: "Learn more", url: "https://ai.google.dev/gemini-api/docs/rate-limits" }],
      },
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            quotaDimensions: { location: "global", model: "gemini-3.6-flash" },
            quotaValue: "5",
          },
        ],
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3.857116819s" },
    ],
  },
});

// Synthesized per the documented behavioral split (Google's docs describe
// "quota_exceeded" as a distinct daily-limit reason from the per-minute
// "rate_limit_exceeded" case above) — not independently captured live, since
// reproducing a real daily-quota exhaustion isn't practical in a test.
const GOOGLE_RPD_BODY = JSON.stringify({
  error: {
    code: 429,
    message: "You exceeded your current quota... Quota exceeded for metric: ...requests, limit: 1500",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
            quotaDimensions: { location: "global", model: "gemini-3.6-flash" },
            quotaValue: "1500",
          },
        ],
      },
    ],
  },
});

function makeAPICallError(overrides: {
  statusCode: number;
  responseBody?: string;
}): APICallError {
  return new APICallError({
    message: "Request failed",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    requestBodyValues: {},
    statusCode: overrides.statusCode,
    responseBody: overrides.responseBody,
    responseHeaders: {},
    isRetryable: overrides.statusCode === 429,
  });
}

describe("classifyModelCallError", () => {
  it("classifies a Google per-minute (RPM) hit as rate_limited with the server's retryDelay", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: GOOGLE_RPM_BODY });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result).toBeInstanceOf(SolveError);
    expect(result.code).toBe("rate_limited");
    expect(result.details.retryAfterSeconds).toBeCloseTo(3.857116819);
  });

  it("classifies a Google daily (RPD) hit as model_error, not rate_limited", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: GOOGLE_RPD_BODY });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("model_error");
    expect(result.details.retryAfterSeconds).toBeUndefined();
  });

  it("falls back to model_error when the 429 body isn't JSON", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: "<html>rate limited</html>" });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("model_error");
  });

  it("falls back to model_error when the 429 body has no QuotaFailure violation", () => {
    const err = makeAPICallError({
      statusCode: 429,
      responseBody: JSON.stringify({ error: { code: 429, message: "rate limited", details: [] } }),
    });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("model_error");
  });

  it("never classifies a non-google provider's 429 as rate_limited", () => {
    const err = makeAPICallError({ statusCode: 429, responseBody: GOOGLE_RPM_BODY });

    const result = classifyModelCallError(err, "openai", { model: "gpt-4.1-nano" });

    expect(result.code).toBe("model_error");
  });

  it("still classifies a non-429 google error as model_error", () => {
    const err = makeAPICallError({ statusCode: 500, responseBody: "internal error" });

    const result = classifyModelCallError(err, "google", { model: "gemini-3.6-flash" });

    expect(result.code).toBe("model_error");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `orchestrator/`): `npm test -- solver.test.ts`
Expected: FAIL — `classifyModelCallError` doesn't accept a `provider` argument yet (TypeScript compile error), and every case currently resolves to `"model_error"` (no `"rate_limited"` branch exists).

- [ ] **Step 4: Implement the classification**

In `orchestrator/src/solver.ts`, add the provider parameter, the `retryAfterSeconds` field, and the Google-specific parsing:

```ts
import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
} from "ai";
import { type SolveErrorCode } from "./types.js";
import { type ModelProvider } from "./provider.js";

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
  // Seconds to wait before retrying — set only for a Google "rate_limited"
  // classification, from the response's own RetryInfo.retryDelay.
  retryAfterSeconds?: number;
}

/**
 * Typed failure from a solve step. `code` distinguishes recoverable bad
 * model output (duplicate/invalid groups) from unrecoverable model/network
 * failures, and (for Google) a per-minute rate limit that isn't a failure
 * at all, so the backend can react appropriately (re-prompt vs. wait vs.
 * abort).
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
 * A Google Generative Language API 429 body follows Google Cloud's standard
 * google.rpc.Status error shape: `error.details[]` carries typed entries,
 * including (for a quota violation) a QuotaFailure with `violations[]` —
 * each violation's `quotaId` names the specific limit that was hit, e.g.
 * "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" — and (usually)
 * a sibling RetryInfo entry with a `retryDelay` like "3.857116819s". This
 * shape was confirmed live against a real key — see this feature's design
 * spec for the full captured example.
 */
interface GoogleQuotaFailureDetail {
  "@type": string;
  violations?: Array<{ quotaId?: string; quotaMetric?: string }>;
}

interface GoogleRetryInfoDetail {
  "@type": string;
  retryDelay?: string;
}

/**
 * Parses a Google 429 responseBody for a per-minute (RPM or TPM) quota
 * violation — the only case this repo treats as retryable rather than a
 * real failure (a per-day violation doesn't clear inside any reasonable
 * wait, so it's deliberately left to fall through to model_error). Returns
 * the seconds to wait (parsed from RetryInfo.retryDelay, e.g. "3.857116819s")
 * when a per-minute violation is found, `undefined` if one is found but no
 * RetryInfo accompanies it, or `null` when the body isn't a per-minute
 * violation at all (including: not JSON, no QuotaFailure, a per-day
 * violation, or any other shape this function doesn't recognize). Never
 * throws — an unparseable/unexpected body is just treated as "not a
 * per-minute hit", falling through to the existing model_error path.
 */
function parseGoogleRateLimit(responseBody: unknown): number | undefined | null {
  if (typeof responseBody !== "string") return null;

  let parsed: { error?: { details?: Array<GoogleQuotaFailureDetail | GoogleRetryInfoDetail> } };
  try {
    parsed = JSON.parse(responseBody);
  } catch {
    return null;
  }

  const details = parsed.error?.details;
  if (!Array.isArray(details)) return null;

  const quotaFailure = details.find(
    (d): d is GoogleQuotaFailureDetail => d["@type"]?.endsWith("QuotaFailure") ?? false,
  );
  const isPerMinute = quotaFailure?.violations?.some(
    (v) => v.quotaId?.includes("PerMinute") || v.quotaMetric?.includes("PerMinute"),
  );
  if (!isPerMinute) return null;

  const retryInfo = details.find(
    (d): d is GoogleRetryInfoDetail => d["@type"]?.endsWith("RetryInfo") ?? false,
  );
  const seconds = retryInfo?.retryDelay ? parseFloat(retryInfo.retryDelay) : NaN;
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Classifies an AI SDK failure from generateObject/generateText into a typed
 * SolveError. Malformed-but-present output (no/undecodable object) is
 * recoverable — callers may re-prompt. Provider/network failures are not,
 * except a Google per-minute rate-limit hit, which classifies as
 * "rate_limited" rather than "model_error" — see parseGoogleRateLimit.
 *
 * When the failure is an APICallError (a real provider request that got a
 * non-2xx response, or a network-level failure the AI SDK wraps the same
 * way), its raw request/response detail — otherwise lost the moment this
 * function returns — rides along on the thrown SolveError's `details`, so
 * the backend can persist it for troubleshooting.
 */
export function classifyModelCallError(
  err: unknown,
  provider: ModelProvider,
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
    : {
        requestBody: undefined,
        statusCode: undefined,
      };

  if (provider === "google" && APICallError.isInstance(err) && err.statusCode === 429) {
    const retryAfterSeconds = parseGoogleRateLimit(err.responseBody);
    if (retryAfterSeconds !== null) {
      return new SolveError("rate_limited", `Google rate limit hit: ${message}`, {
        ...details,
        ...apiDetails,
        errorName: err.name,
        retryAfterSeconds,
      });
    }
  }

  return new SolveError("model_error", `Model call failed: ${message}`, {
    ...details,
    ...apiDetails,
    errorName: err instanceof Error ? err.name : undefined,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- solver.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/solver.ts orchestrator/src/solver.test.ts orchestrator/src/types.ts
git commit -m "feat: classify Google per-minute rate limits as a distinct, retryable error"
```

---

## Task 3: Orchestrator — thread the provider through and surface `rate_limited` over HTTP

**Files:**
- Modify: `orchestrator/src/solve-assist.ts`
- Modify: `orchestrator/src/app.ts`
- Modify: `orchestrator/src/app.test.ts`

**Interfaces:**
- Consumes: `classifyModelCallError(err, provider, details)` (Task 2).
- Produces: `POST /solve-assist` returns HTTP 429 with `retryAfterSeconds` in `details` for a `rate_limited` failure.

- [ ] **Step 1: Write the failing test**

Add to `orchestrator/src/app.test.ts`, inside `describe("POST /solve-assist", ...)` (place after the existing "accepts google as a provider value" test — see that test for the exact `solveAssistMock`/`solveAssistRequest` pattern this file already uses):

```ts
    it("returns 429 with retryAfterSeconds for a rate_limited failure", async () => {
      const { SolveError } = await import("./solver.js");
      solveAssistMock.mockRejectedValueOnce(
        new SolveError("rate_limited", "Google rate limit hit", { retryAfterSeconds: 3.86 }),
      );

      const res = await solveAssistRequest({
        messages: SOLVE_ASSIST_BODY.messages,
        model: "gemini-3.6-flash",
        provider: "google",
      });

      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.code).toBe("rate_limited");
      expect(body.details.retryAfterSeconds).toBe(3.86);
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `orchestrator/`): `npm test -- app.test.ts`
Expected: FAIL — `ERROR_STATUS["rate_limited"]` is `undefined` (not yet in the map), so Hono's `c.json(..., undefined)` doesn't produce a 429.

- [ ] **Step 3: Update `ERROR_STATUS` and the `solveAssist` call site**

In `orchestrator/src/app.ts`, widen the status map:

```ts
const ERROR_STATUS: Record<SolveError["code"], 409 | 400 | 429 | 502> = {
  duplicate_group: 409,
  invalid_group: 400,
  model_error: 502,
  rate_limited: 429,
};
```

In `orchestrator/src/solve-assist.ts`, pass `resolvedProvider` into `classifyModelCallError`:

```ts
  } catch (err) {
    throw classifyModelCallError(err, resolvedProvider, {
      model: getModelName(resolvedProvider, model),
      latencyMs: Date.now() - startTime,
    });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- app.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/solve-assist.ts orchestrator/src/app.ts orchestrator/src/app.test.ts
git commit -m "feat: surface rate_limited as HTTP 429 with retryAfterSeconds"
```

---

## Task 4: Backend — `OrchestratorService` picks up `rate_limited`/`retryAfterSeconds`

**Files:**
- Modify: `backend/src/modules/strategy/orchestrator.service.ts`
- Modify: `backend/src/modules/strategy/orchestrator.service.spec.ts`

**Interfaces:**
- Produces: `SolveErrorCode` (backend-local type) gains `"rate_limited"`. `SolveAssistFailure` gains `retryAfterSeconds?: number`.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/modules/strategy/orchestrator.service.spec.ts`, after the existing "should include the google provider in the request body when given" test:

```ts
  it("should extract retryAfterSeconds from a rate_limited failure", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 429,
        body: {
          error: "Google rate limit hit",
          code: "rate_limited",
          details: { retryAfterSeconds: 3.86 },
        },
      }),
    );

    const outcome = await service.solveAssist(messages, "gemini-3.6-flash", "google");

    expect(outcome).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "rate_limited",
        retryAfterSeconds: 3.86,
        statusCode: 429,
      }),
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- orchestrator.service.spec.ts`
Expected: FAIL — `isKnownErrorCode` doesn't recognize `"rate_limited"` (falls back to `"model_error"`), and `extractCallDetail` doesn't pick up `retryAfterSeconds` at all.

- [ ] **Step 3: Widen the type and extraction**

In `backend/src/modules/strategy/orchestrator.service.ts`:

```ts
export type SolveErrorCode = "duplicate_group" | "invalid_group" | "model_error" | "rate_limited";
```

```ts
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
  // Seconds to wait before retrying — set only when code is "rate_limited".
  retryAfterSeconds?: number;
}
```

```ts
  private extractCallDetail(
    details?: Record<string, unknown>,
  ): Pick<
    SolveAssistFailure,
    | "requestBody"
    | "responseId"
    | "responseHeaders"
    | "responseBody"
    | "statusCode"
    | "errorName"
    | "isRetryable"
    | "retryAfterSeconds"
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
      retryAfterSeconds: details.retryAfterSeconds as number | undefined,
    };
  }
```

```ts
  private isKnownErrorCode(code: string | undefined): code is SolveErrorCode {
    return (
      code === "duplicate_group" ||
      code === "invalid_group" ||
      code === "model_error" ||
      code === "rate_limited"
    );
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- orchestrator.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/modules/strategy/orchestrator.service.ts backend/src/modules/strategy/orchestrator.service.spec.ts
git commit -m "feat: extract rate_limited/retryAfterSeconds in OrchestratorService"
```

---

## Task 5: Backend — rate-limit fallback wait config

**Files:**
- Modify: `backend/src/strategies.ts`
- Modify: `backend/src/strategies.spec.ts`

**Interfaces:**
- Produces: `DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS = 60`. `llmGoogleRateLimitFallbackSeconds(env?): number`.

- [ ] **Step 1: Write the failing tests**

Add `DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS` and `llmGoogleRateLimitFallbackSeconds` to the import block at the top of `backend/src/strategies.spec.ts`, then add:

```ts
  describe("llmGoogleRateLimitFallbackSeconds", () => {
    it("should default when the env var is missing", () => {
      expect(llmGoogleRateLimitFallbackSeconds({})).toBe(DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS);
    });

    it("should default when the env var is invalid", () => {
      expect(llmGoogleRateLimitFallbackSeconds({ LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS: "abc" })).toBe(
        DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS,
      );
      expect(llmGoogleRateLimitFallbackSeconds({ LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS: "0" })).toBe(
        DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmGoogleRateLimitFallbackSeconds({ LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS: "90" })).toBe(90);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- strategies.spec.ts`
Expected: FAIL — `llmGoogleRateLimitFallbackSeconds`/`DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS` don't exist yet.

- [ ] **Step 3: Implement**

In `backend/src/strategies.ts`, add near `DEFAULT_LLM_GOOGLE_CONCURRENCY`:

```ts
// Fallback wait (seconds) before retrying after a Google per-minute
// rate-limit hit, used only when Google's own RetryInfo.retryDelay is
// absent from the error — see llm-strategy-runner.service.ts.
export const DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS = 60;
```

Add the accessor next to `llmGoogleConcurrency`:

```ts
/**
 * Fallback wait (seconds) before retrying a Google per-minute rate-limit
 * hit, from LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS. Only used when Google's
 * own RetryInfo.retryDelay wasn't present on the error. Falls back to
 * DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS for missing/invalid values.
 */
export function llmGoogleRateLimitFallbackSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return positiveTrialCount(
    env.LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS,
    DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- strategies.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/strategies.ts backend/src/strategies.spec.ts
git commit -m "feat: add the Google rate-limit fallback wait setting"
```

---

## Task 6: Backend — wait-and-retry on `rate_limited`, never counted as a failure

**Files:**
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.ts`
- Modify: `backend/src/modules/strategy/llm-strategy-runner.service.spec.ts`

**Interfaces:**
- Consumes: `llmGoogleRateLimitFallbackSeconds()` (Task 5), `outcome.error.retryAfterSeconds` (Task 4).
- Produces: `classifyFailedCall` gains a `retryAfterSeconds?: number` parameter; a `"rate_limited"` code never increments any counter or changes `run.status`.

- [ ] **Step 1: Write the failing tests**

`backend/src/modules/strategy/llm-strategy-runner.service.spec.ts` has no import from `"../../strategies"` today (it mocks `LlmStrategyRunner`'s injected dependencies directly, not `strategies.ts`'s functions) — no import change is needed. The three tests below only need `runner`'s `delay` spy and `mockOrchestratorService`, both already set up in this file's existing `beforeEach`.

Add these three tests, placed after the existing "should write a CALL_ERROR row for a terminal failure, carrying whatever raw detail the orchestrator returned" test:

```ts
    it("should wait the server-specified retryAfterSeconds and retry, without counting a rate_limited hit as a failure", async () => {
      const delaySpy = jest
        .spyOn(runner as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);

      mockOrchestratorService.solveAssist
        .mockResolvedValueOnce({
          ok: false,
          error: { error: "rate limited", code: "rate_limited", retryAfterSeconds: 3.86 },
        })
        .mockResolvedValueOnce(
          makeAssistResponse([
            ["APPLE", "BANANA", "CHERRY", "DATE"],
            ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
          ]),
        );

      await runner.runLlmStrategy(100, "llm-google", 0, "gemini-3.6-flash");

      expect(delaySpy).toHaveBeenCalledWith(3860);
      const runSave = mockManager.save.mock.calls.find(
        (call: unknown[]) => call[0] === StrategyRun,
      );
      expect(runSave?.[1]).not.toEqual(expect.objectContaining({ status: StrategyRunStatus.ERROR }));
    });

    it("should never terminate the run for repeated rate_limited hits, however many occur", async () => {
      jest
        .spyOn(runner as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);

      // Comfortably past DEFAULT_LLM_MAX_MODEL_ERRORS (5) — proves rate_limited
      // never feeds that counter, regardless of count.
      const RATE_LIMIT_HITS = 8;
      for (let i = 0; i < RATE_LIMIT_HITS; i++) {
        mockOrchestratorService.solveAssist.mockResolvedValueOnce({
          ok: false,
          error: { error: "rate limited", code: "rate_limited", retryAfterSeconds: 1 },
        });
      }
      mockOrchestratorService.solveAssist.mockResolvedValueOnce(
        makeAssistResponse([
          ["APPLE", "BANANA", "CHERRY", "DATE"],
          ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
        ]),
      );

      const result = await runner.runLlmStrategy(100, "llm-google", 0, "gemini-3.6-flash");

      expect(mockOrchestratorService.solveAssist).toHaveBeenCalledTimes(RATE_LIMIT_HITS + 1);
      expect(result.status).not.toBe(StrategyRunStatus.ERROR);
    });

    it("should fall back to llmGoogleRateLimitFallbackSeconds when retryAfterSeconds is absent", async () => {
      process.env.LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS = "45";
      const delaySpy = jest
        .spyOn(runner as unknown as { delay(ms: number): Promise<void> }, "delay")
        .mockResolvedValue(undefined);

      try {
        mockOrchestratorService.solveAssist
          .mockResolvedValueOnce({
            ok: false,
            error: { error: "rate limited", code: "rate_limited" },
          })
          .mockResolvedValueOnce(
            makeAssistResponse([
              ["APPLE", "BANANA", "CHERRY", "DATE"],
              ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
            ]),
          );

        await runner.runLlmStrategy(100, "llm-google", 0, "gemini-3.6-flash");

        expect(delaySpy).toHaveBeenCalledWith(45000);
      } finally {
        delete process.env.LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS;
      }
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- llm-strategy-runner.service.spec.ts`
Expected: FAIL — `classifyFailedCall`'s current three-way branch treats `"rate_limited"` as the `else` (malformed) case: `state.malformedCount` increments and, in the repeated-hits test, the run ends with `StrategyRunStatus.MALFORMED_RESPONSE` well before all 8 attempts happen. `delaySpy` is never called with the expected values since nothing sets a rate-limit-specific wait yet.

- [ ] **Step 3: Implement**

In `backend/src/modules/strategy/llm-strategy-runner.service.ts`, add the import:

```ts
import {
  LLM_OLLAMA,
  LLM_GOOGLE,
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmGoogleRateLimitFallbackSeconds,
  llmTemperature,
} from "../../strategies";
```

Add `rateLimitWaitMs` to `LlmRunLoopState`:

```ts
interface LlmRunLoopState {
  guessCount: number;
  duplicateCount: number;
  failedGuessCount: number;
  malformedCount: number;
  consecutiveModelErrors: number;
  // Set by classifyFailedCall for a "rate_limited" hit — the run loop's
  // post-flush wait step checks this before the model-error backoff, and
  // resets it to null after waiting. Never counts toward any failure
  // threshold; a rate_limited hit is never treated as a failure at all.
  rateLimitWaitMs: number | null;
  // Groups confirmed correct — used to build RETRY prompts.
  lockedInGroups: string[][];
  // The last failed guess — used to build RETRY prompts.
  lastFailedGuess: { items: string[]; result: string } | null;
  priorGuesses: { words: string[]; result: GuessResult }[];
}
```

Initialize it in `runLlmStrategy`'s `state` literal:

```ts
    const state: LlmRunLoopState = {
      guessCount: priorGuesses.length,
      duplicateCount: priorGuesses.filter((guess) => guess.result === GuessResult.DUPLICATE).length,
      failedGuessCount: priorGuesses.filter(
        (guess) => guess.result === GuessResult.FAILURE || guess.result === GuessResult.OFF_BY_ONE,
      ).length,
      malformedCount: 0,
      consecutiveModelErrors: 0,
      rateLimitWaitMs: null,
      lockedInGroups: [],
      lastFailedGuess: null,
      priorGuesses,
    };
```

Pass `outcome.error.retryAfterSeconds` through to `classifyFailedCall`:

```ts
        this.classifyFailedCall(
          outcome.error.code,
          run,
          state,
          maxModelErrors,
          maxDuplicates,
          maxMalformed,
          outcome.error.retryAfterSeconds,
        );
```

Update the post-flush wait step to check `rateLimitWaitMs` first:

```ts
      // A rate-limited hit waits exactly as long as Google says to, taking
      // priority over the model-error backoff below — the two never apply
      // to the same failed call (classifyFailedCall sets at most one).
      if (run.status === StrategyRunStatus.RUNNING && state.rateLimitWaitMs !== null) {
        await this.delay(state.rateLimitWaitMs);
        state.rateLimitWaitMs = null;
      } else if (run.status === StrategyRunStatus.RUNNING && state.consecutiveModelErrors > 0) {
        await this.delay(this.modelErrorBackoff(state.consecutiveModelErrors));
      }
```

Update `classifyFailedCall`:

```ts
  /**
   * Classifies a failed orchestrator call (no assistant reply at all).
   * "rate_limited" (Google per-minute hit only) is never a failure — it
   * touches no counter and never changes run.status, only sets
   * state.rateLimitWaitMs so the run loop waits the server-specified
   * duration and retries the identical request. Every other code bumps
   * that failure kind's own counter, ending the run once its limit is hit
   * — or otherwise leaves run.status as RUNNING so the loop retries next
   * iteration.
   */
  private classifyFailedCall(
    code: SolveErrorCode,
    run: StrategyRun,
    state: LlmRunLoopState,
    maxModelErrors: number,
    maxDuplicates: number,
    maxMalformed: number,
    retryAfterSeconds?: number,
  ): void {
    if (code === "rate_limited") {
      state.rateLimitWaitMs =
        (retryAfterSeconds ?? llmGoogleRateLimitFallbackSeconds()) * 1000;
    } else if (code === "model_error") {
      state.consecutiveModelErrors++;
      if (state.consecutiveModelErrors >= maxModelErrors) {
        run.status = StrategyRunStatus.ERROR;
        run.finishedAt = new Date();
      }
    } else if (code === "duplicate_group") {
      state.duplicateCount++;
      if (state.duplicateCount >= maxDuplicates) {
        run.status = StrategyRunStatus.DUPLICATE;
        run.finishedAt = new Date();
      }
    } else {
      state.malformedCount++;
      if (state.malformedCount >= maxMalformed) {
        run.status = StrategyRunStatus.MALFORMED_RESPONSE;
        run.finishedAt = new Date();
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- llm-strategy-runner.service.spec.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Run the full backend suite**

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add backend/src/modules/strategy/llm-strategy-runner.service.ts backend/src/modules/strategy/llm-strategy-runner.service.spec.ts
git commit -m "feat: wait and retry on a Google rate_limited hit instead of failing"
```

---

## Task 7: Config docs

**Files:**
- Modify: `.env.sample`
- Modify: `README.md`

**Interfaces:**
- Consumes: `LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS` (read by Task 5's `strategies.ts`).
- Produces: no code interface — documentation only. No test.

- [ ] **Step 1: Update `.env.sample`**

Add right after the existing `LLM_GOOGLE_CONCURRENCY=1` line:

```
# Fallback wait (seconds) before retrying after a Google per-minute
# rate-limit hit (RPM or TPM) — only used when Google's own RetryInfo
# doesn't specify a wait. A per-minute hit is never treated as a run
# failure; it waits and retries indefinitely. (default: 60)
LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS=60
```

- [ ] **Step 2: Update `README.md`**

Add a row to the env var table right after the existing `LLM_GOOGLE_CONCURRENCY` row:

```
| `LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS` | `60` | Fallback wait before retrying a Google per-minute rate-limit hit, used only when Google's own `RetryInfo` doesn't specify one. A per-minute hit (RPM or TPM) is never a run failure — it waits and retries indefinitely; only a daily-quota hit counts toward `LLM_MAX_MODEL_ERRORS` |
```

- [ ] **Step 3: Commit**

```bash
git add .env.sample README.md
git commit -m "docs: document the Google rate-limit fallback wait setting"
```
