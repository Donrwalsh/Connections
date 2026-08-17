import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, SOLVE_BODY_LIMIT } from "./app.js";
import { SolveError } from "./solver.js";

const KEY = "test-internal-key";

function solveRequest(body: unknown) {
  return app.request("/solve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-api-key": KEY,
    },
    body: JSON.stringify(body),
  });
}

const SOLVE_BODY = {
  puzzleWords: ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"],
};

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
  proposeGroup: vi.fn(async () => {
    throw new Error("model call failed");
  }),
}));

vi.mock("./assist.js", () => ({
  runAssistStep: vi.fn(async () => {
    throw new Error("model call failed");
  }),
}));

import { proposeGroup } from "./solver.js";
import { runAssistStep } from "./assist.js";
const proposeGroupMock = vi.mocked(proposeGroup);
const runAssistStepMock = vi.mocked(runAssistStep);

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

describe("orchestrator app", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_KEY = KEY;
    proposeGroupMock.mockReset();
    proposeGroupMock.mockRejectedValue(new Error("model call failed"));
    runAssistStepMock.mockReset();
    runAssistStepMock.mockRejectedValue(new Error("model call failed"));
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

  it("rejects an invalid solve body", async () => {
    const res = await solveRequest({ puzzleWords: ["too", "few"] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid request body" });
  });

  it("rejects a body over the size limit", async () => {
    const res = await solveRequest({
      puzzleWords: ["x".repeat(SOLVE_BODY_LIMIT + 1)],
    });
    expect(res.status).toBe(413);
  });

  it("returns 502 when the model call fails", async () => {
    const res = await solveRequest(SOLVE_BODY);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; details: string };
    expect(body.error).toBe("Solve failed");
    expect(body.details).toContain("model call failed");
  });

  it("returns the extended success body", async () => {
    proposeGroupMock.mockResolvedValueOnce({
      proposedGroups: [
        {
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
        },
      ],
      proposals: [
        {
          promptNumber: 1,
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
          status: "used",
        },
        {
          promptNumber: 1,
          word_ids: [4, 5, 6, 7],
          category: "Test",
          confidence: 0.8,
          reasoning: "test",
          status: "not_selected",
        },
      ],
      prompt: "You are solving...",
      model: "test-model",
      contextWindow: 8192,
      latencyMs: 1234,
      temperature: 1.0,
      numResponses: 1,
      promptAttempts: 1,
      duplicatesRejected: 0,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      promptMetadata: [
        {
          attempt: 1,
          temperature: 1.0,
          numResponses: 1,
          model: "test-model",
          contextWindow: 8192,
          latencyMs: 1234,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          outcome: "accepted",
        },
      ],
    });

    const res = await solveRequest(SOLVE_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      proposedGroups: [
        {
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
        },
      ],
      proposals: [
        {
          promptNumber: 1,
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
          status: "used",
        },
        {
          promptNumber: 1,
          word_ids: [4, 5, 6, 7],
          category: "Test",
          confidence: 0.8,
          reasoning: "test",
          status: "not_selected",
        },
      ],
      prompt: "You are solving...",
      model: "test-model",
      contextWindow: 8192,
      latencyMs: 1234,
      temperature: 1.0,
      numResponses: 1,
      promptAttempts: 1,
      duplicatesRejected: 0,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      promptMetadata: [
        {
          attempt: 1,
          temperature: 1.0,
          numResponses: 1,
          model: "test-model",
          contextWindow: 8192,
          latencyMs: 1234,
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          outcome: "accepted",
        },
      ],
    });
  });

  it("passes an optional temperature through to the solve step", async () => {
    proposeGroupMock.mockResolvedValueOnce({
      proposedGroups: [
        {
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
        },
      ],
      proposals: [
        {
          promptNumber: 1,
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
          status: "used",
        },
      ],
      prompt: "You are solving...",
      model: "test-model",
      contextWindow: 8192,
      latencyMs: 10,
      temperature: 1.2,
      numResponses: 1,
      promptAttempts: 1,
      duplicatesRejected: 0,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      promptMetadata: [],
    });

    const res = await solveRequest({ ...SOLVE_BODY, temperature: 1.2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { temperature: number };
    expect(body.temperature).toBe(1.2);
    expect(proposeGroupMock).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 1.2 }),
    );
  });

  it("defaults the model provider when the request omits it", async () => {
    proposeGroupMock.mockResolvedValueOnce({
      proposedGroups: [
        {
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
        },
      ],
      proposals: [
        {
          promptNumber: 1,
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
          status: "used",
        },
      ],
      prompt: "You are solving...",
      model: "test-model",
      contextWindow: 8192,
      latencyMs: 10,
      temperature: 0,
      numResponses: 1,
      promptAttempts: 1,
      duplicatesRejected: 0,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      promptMetadata: [],
    });

    const res = await solveRequest(SOLVE_BODY);
    expect(res.status).toBe(200);
    expect(proposeGroupMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "openai" }),
    );
  });

  it("uses the MODEL_PROVIDER default for provider-less requests", async () => {
    vi.stubEnv("MODEL_PROVIDER", "ollama");
    proposeGroupMock.mockResolvedValueOnce({
      proposedGroups: [
        {
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
        },
      ],
      proposals: [
        {
          promptNumber: 1,
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
          status: "used",
        },
      ],
      prompt: "You are solving...",
      model: "test-model",
      contextWindow: 8192,
      latencyMs: 10,
      temperature: 0,
      numResponses: 1,
      promptAttempts: 1,
      duplicatesRejected: 0,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      promptMetadata: [],
    });

    const res = await solveRequest(SOLVE_BODY);
    expect(res.status).toBe(200);
    expect(proposeGroupMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "ollama" }),
    );
  });

  it("passes an explicit model provider through to the solve step", async () => {
    proposeGroupMock.mockResolvedValueOnce({
      proposedGroups: [
        {
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
        },
      ],
      proposals: [
        {
          promptNumber: 1,
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
          status: "used",
        },
      ],
      prompt: "You are solving...",
      model: "test-model",
      contextWindow: 8192,
      latencyMs: 10,
      temperature: 0,
      numResponses: 1,
      promptAttempts: 1,
      duplicatesRejected: 0,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      promptMetadata: [],
    });

    const res = await solveRequest({ ...SOLVE_BODY, modelProvider: "ollama" });
    expect(res.status).toBe(200);
    expect(proposeGroupMock).toHaveBeenCalledWith(
      expect.objectContaining({ modelProvider: "ollama" }),
    );
  });

  it("rejects a temperature outside the supported range", async () => {
    const res = await solveRequest({ ...SOLVE_BODY, temperature: 11 });
    expect(res.status).toBe(400);
  });

  it("maps duplicate_group to 409", async () => {
    proposeGroupMock.mockRejectedValueOnce(
      new SolveError("duplicate_group", "repeated group", {
        proposedGroups: [
          {
            word_ids: [0, 1, 2, 3],
            category: "Test",
            confidence: 0.9,
            reasoning: "test",
          },
        ],
      }),
    );
    const res = await solveRequest(SOLVE_BODY);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("duplicate_group");
    expect(
      (body.details as { proposedGroups: unknown }).proposedGroups,
    ).toEqual([
      {
        word_ids: [0, 1, 2, 3],
        category: "Test",
        confidence: 0.9,
        reasoning: "test",
      },
    ]);
  });

  it("maps invalid_group to 400", async () => {
    proposeGroupMock.mockRejectedValueOnce(
      new SolveError("invalid_group", "malformed output"),
    );
    const res = await solveRequest(SOLVE_BODY);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("invalid_group");
  });

  it("maps model_error to 502", async () => {
    proposeGroupMock.mockRejectedValueOnce(
      new SolveError("model_error", "ollama is down"),
    );
    const res = await solveRequest(SOLVE_BODY);
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("model_error");
    expect(body.error).toContain("ollama is down");
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

    it("returns the model's raw answer and parsed groups", async () => {
      runAssistStepMock.mockResolvedValueOnce({
        response: "Reasoning.\nANSWER:\nAAAA, BBBB, CCCC, DDDD\nEEEE, FFFF, GGGG, HHHH",
        groups: [
          ["AAAA", "BBBB", "CCCC", "DDDD"],
          ["EEEE", "FFFF", "GGGG", "HHHH"],
        ],
        model: "test-model",
      });

      const res = await diagnoseRequest(DIAGNOSE_BODY);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        response: "Reasoning.\nANSWER:\nAAAA, BBBB, CCCC, DDDD\nEEEE, FFFF, GGGG, HHHH",
        groups: [
          ["AAAA", "BBBB", "CCCC", "DDDD"],
          ["EEEE", "FFFF", "GGGG", "HHHH"],
        ],
        model: "test-model",
      });
      expect(runAssistStepMock).toHaveBeenCalledWith(DIAGNOSE_BODY.messages);
    });

    it("maps an unusable response to 400", async () => {
      runAssistStepMock.mockRejectedValueOnce(
        new SolveError(
          "invalid_group",
          'Model response contained no "ANSWER:" section with group lines',
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
});
