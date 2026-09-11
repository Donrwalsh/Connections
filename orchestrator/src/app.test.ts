import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, SOLVE_BODY_LIMIT } from "./app.js";
import { SolveError } from "./solver.js";

const KEY = "test-internal-key";

vi.mock("./solver.js", () => ({
  SolveError: class SolveError extends Error {
    constructor(code: string, message: string, details: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
    code!: string;
    details!: unknown;
  },
}));

vi.mock("./answer-step.js", () => ({
  runAnswerStep: vi.fn(async () => {
    throw new Error("model call failed");
  }),
}));

vi.mock("./judge-category.js", () => ({
  judgeCategory: vi.fn(async () => {
    throw new Error("model call failed");
  }),
}));

import { runAnswerStep } from "./answer-step.js";
import { judgeCategory } from "./judge-category.js";
const runAnswerStepMock = vi.mocked(runAnswerStep);
const judgeCategoryMock = vi.mocked(judgeCategory);

function diagnoseRequest(body: unknown) {
  return app.request("/diagnose", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-key": KEY,
    },
    body: JSON.stringify(body),
  });
}

function solveStepRequest(body: unknown) {
  return app.request("/solve-step", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-key": KEY,
    },
    body: JSON.stringify(body),
  });
}

function judgeCategoryRequest(
  body: unknown,
  headers: Record<string, string> = { "x-internal-api-key": KEY },
) {
  return app.request("/judge-category", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("orchestrator app", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_KEY = KEY;
    runAnswerStepMock.mockReset();
    runAnswerStepMock.mockRejectedValue(new Error("model call failed"));
    judgeCategoryMock.mockReset();
    judgeCategoryMock.mockRejectedValue(new Error("model call failed"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("GET /health returns ok", async () => {
    const res = await app.request("/health", {
      headers: { "x-internal-api-key": KEY },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("fails loudly when INTERNAL_API_KEY is not configured", async () => {
    vi.stubEnv("INTERNAL_API_KEY", "");
    const res = await app.request("/health");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      error: "Server misconfigured: INTERNAL_API_KEY not set",
    });
  });

  it("rejects requests with a wrong internal key", async () => {
    const res = await app.request("/health", {
      headers: { "x-internal-api-key": "wrong-key" },
    });
    expect(res.status).toBe(401);
  });

  describe("POST /diagnose", () => {
    const DIAGNOSE_BODY = {
      messages: [
        {
          role: "user",
          content:
            "You are playing NYT Connections. The items below form 2 groups of four...",
        },
      ],
    };

    it("rejects an invalid diagnose body", async () => {
      const res = await diagnoseRequest({ messages: [] });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "Invalid request body",
      });
    });

    it("returns 502 when the model call fails", async () => {
      const res = await diagnoseRequest(DIAGNOSE_BODY);
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string; details: string };
      expect(body.error).toBe("Diagnose failed");
      expect(body.details).toContain("model call failed");
    });

    it("returns the model's raw answer and parsed groups, trimmed to the button's contract", async () => {
      runAnswerStepMock.mockResolvedValueOnce({
        response: "### GROUPS\n#### Group 1\nCategory: A\nWords: AAAA, BBBB, CCCC, DDDD\n\n### ANSWER\nAAAA, BBBB, CCCC, DDDD\nEEEE, FFFF, GGGG, HHHH",
        groups: [
          ["AAAA", "BBBB", "CCCC", "DDDD"],
          ["EEEE", "FFFF", "GGGG", "HHHH"],
        ],
        proposalWords: [["AAAA", "BBBB", "CCCC", "DDDD"]],
        categoryByGroup: { "1": "A" },
        textIssues: [],
        model: "test-model",
        latencyMs: 5,
      });

      const res = await diagnoseRequest(DIAGNOSE_BODY);
      expect(res.status).toBe(200);
      // Trimmed to exactly {response, groups, model} — the richer fields
      // runAnswerStep returns (proposalWords, categoryByGroup, textIssues,
      // latencyMs, ...) never leak onto the button's wire contract.
      expect(await res.json()).toEqual({
        response: "### GROUPS\n#### Group 1\nCategory: A\nWords: AAAA, BBBB, CCCC, DDDD\n\n### ANSWER\nAAAA, BBBB, CCCC, DDDD\nEEEE, FFFF, GGGG, HHHH",
        groups: [
          ["AAAA", "BBBB", "CCCC", "DDDD"],
          ["EEEE", "FFFF", "GGGG", "HHHH"],
        ],
        model: "test-model",
      });
      expect(runAnswerStepMock).toHaveBeenCalledWith(DIAGNOSE_BODY.messages, {
        captureTelemetry: false,
      });
    });

    it("maps an unusable response to 400", async () => {
      runAnswerStepMock.mockRejectedValueOnce(
        new SolveError(
          "invalid_group",
          'Model response contained no parseable group proposals or "ANSWER:" section',
        ),
      );
      const res = await diagnoseRequest(DIAGNOSE_BODY);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("invalid_group");
    });

    it("rejects a body over the size limit", async () => {
      const res = await diagnoseRequest({
        messages: [{ role: "user", content: "x".repeat(SOLVE_BODY_LIMIT + 1) }],
      });
      expect(res.status).toBe(413);
    });
  });

  describe("POST /solve-step", () => {
    const SOLVE_STEP_BODY = {
      messages: [{ role: "user", content: "Analyze the 16 provided items..." }],
      model: "gpt-4.1-nano-2025-04-14",
      provider: "openai",
    };
    const BASE_RESULT = {
      response: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      groups: [["AAAA", "BBBB", "CCCC", "DDDD"]],
      proposalWords: [["AAAA", "BBBB", "CCCC", "DDDD"]],
      categoryByGroup: {},
      textIssues: [],
      latencyMs: 5,
    };

    it("passes model and provider through to runAnswerStep", async () => {
      runAnswerStepMock.mockResolvedValueOnce({
        ...BASE_RESULT,
        model: "gpt-4.1-nano-2025-04-14",
      });

      const res = await solveStepRequest(SOLVE_STEP_BODY);

      expect(res.status).toBe(200);
      expect(runAnswerStepMock).toHaveBeenCalledWith(
        SOLVE_STEP_BODY.messages,
        expect.objectContaining({
          model: "gpt-4.1-nano-2025-04-14",
          provider: "openai",
          contextWindow: undefined,
          abortSignal: expect.any(AbortSignal),
        }),
      );
    });

    it("passes contextWindow through to runAnswerStep when given", async () => {
      runAnswerStepMock.mockResolvedValueOnce({ ...BASE_RESULT, model: "mistral-nemo" });

      const res = await solveStepRequest({ ...SOLVE_STEP_BODY, contextWindow: 131072 });

      expect(res.status).toBe(200);
      expect(runAnswerStepMock).toHaveBeenCalledWith(
        SOLVE_STEP_BODY.messages,
        expect.objectContaining({
          model: "gpt-4.1-nano-2025-04-14",
          provider: "openai",
          contextWindow: 131072,
          abortSignal: expect.any(AbortSignal),
        }),
      );
    });

    it("works without model/provider (falls back to the env-configured default)", async () => {
      runAnswerStepMock.mockResolvedValueOnce({ ...BASE_RESULT, model: "gpt-4.1-nano" });

      const res = await solveStepRequest({ messages: SOLVE_STEP_BODY.messages });

      expect(res.status).toBe(200);
      expect(runAnswerStepMock).toHaveBeenCalledWith(
        SOLVE_STEP_BODY.messages,
        expect.objectContaining({
          model: undefined,
          provider: undefined,
          contextWindow: undefined,
          abortSignal: expect.any(AbortSignal),
        }),
      );
    });

    it("rejects an unknown provider value", async () => {
      const res = await solveStepRequest({
        messages: SOLVE_STEP_BODY.messages,
        provider: "anthropic",
      });

      expect(res.status).toBe(400);
      expect(runAnswerStepMock).not.toHaveBeenCalled();
    });

    it("accepts google as a provider value", async () => {
      runAnswerStepMock.mockResolvedValueOnce({ ...BASE_RESULT, model: "gemini-3.6-flash" });

      const res = await solveStepRequest({
        messages: SOLVE_STEP_BODY.messages,
        model: "gemini-3.6-flash",
        provider: "google",
      });

      expect(res.status).toBe(200);
      expect(runAnswerStepMock).toHaveBeenCalledWith(
        SOLVE_STEP_BODY.messages,
        expect.objectContaining({ model: "gemini-3.6-flash", provider: "google" }),
      );
    });

    it("accepts mistral as a provider value", async () => {
      runAnswerStepMock.mockResolvedValueOnce({ ...BASE_RESULT, model: "mistral-small-latest" });

      const res = await solveStepRequest({
        messages: SOLVE_STEP_BODY.messages,
        model: "mistral-small-latest",
        provider: "mistral",
      });

      expect(res.status).toBe(200);
      expect(runAnswerStepMock).toHaveBeenCalledWith(
        SOLVE_STEP_BODY.messages,
        expect.objectContaining({ model: "mistral-small-latest", provider: "mistral" }),
      );
    });

    it("returns 429 with retryAfterSeconds for a rate_limited failure", async () => {
      const { SolveError } = await import("./solver.js");
      runAnswerStepMock.mockRejectedValueOnce(
        new SolveError("rate_limited", "Google rate limit hit", { retryAfterSeconds: 3.86 }),
      );

      const res = await solveStepRequest({
        messages: SOLVE_STEP_BODY.messages,
        model: "gemini-3.6-flash",
        provider: "google",
      });

      expect(res.status).toBe(429);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("rate_limited");
      expect((body.details as Record<string, unknown>).retryAfterSeconds).toBe(3.86);
    });

    it("returns 429 for a rate_limited_daily failure", async () => {
      const { SolveError } = await import("./solver.js");
      runAnswerStepMock.mockRejectedValueOnce(
        new SolveError("rate_limited_daily", "Google daily quota exhausted"),
      );

      const res = await solveStepRequest({
        messages: SOLVE_STEP_BODY.messages,
        model: "gemini-3.6-flash",
        provider: "google",
      });

      expect(res.status).toBe(429);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("rate_limited_daily");
      // The absence of a retry hint is the whole behavioural distinction
      // from a plain rate_limited hit.
      expect((body.details as Record<string, unknown>)?.retryAfterSeconds).toBeUndefined();
    });
  });

  describe("POST /judge-category", () => {
    it("returns the verdict and rationale from judgeCategory", async () => {
      judgeCategoryMock.mockResolvedValueOnce({
        verdict: "correct",
        rationale: "Same connection.",
        model: "gpt-4.1-nano",
        latencyMs: 5,
      });

      const res = await judgeCategoryRequest({
        proposedCategory: "A",
        actualCategory: "B",
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        verdict: "correct",
        rationale: "Same connection.",
      });
      expect(judgeCategoryMock).toHaveBeenCalledWith(
        "A",
        "B",
        undefined,
        undefined,
        expect.any(AbortSignal),
      );
    });

    it("accepts mistral as a provider value", async () => {
      judgeCategoryMock.mockResolvedValueOnce({
        verdict: "correct",
        rationale: "Same connection.",
        model: "mistral-small-latest",
        latencyMs: 5,
      });

      const res = await judgeCategoryRequest({
        proposedCategory: "A",
        actualCategory: "B",
        model: "mistral-small-latest",
        provider: "mistral",
      });

      expect(res.status).toBe(200);
      expect(judgeCategoryMock).toHaveBeenCalledWith(
        "A",
        "B",
        "mistral-small-latest",
        "mistral",
        expect.any(AbortSignal),
      );
    });

    it("rejects a request with no internal key", async () => {
      const res = await judgeCategoryRequest(
        { proposedCategory: "A", actualCategory: "B" },
        {},
      );
      expect(res.status).toBe(401);
      expect(judgeCategoryMock).not.toHaveBeenCalled();
    });

    it("rejects an empty request body", async () => {
      const res = await judgeCategoryRequest({});
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "Invalid request body" });
      expect(judgeCategoryMock).not.toHaveBeenCalled();
    });
  });
});
