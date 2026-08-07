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

import { proposeGroup } from "./solver.js";
const proposeGroupMock = vi.mocked(proposeGroup);

describe("orchestrator app", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_KEY = KEY;
    proposeGroupMock.mockReset();
    proposeGroupMock.mockRejectedValue(new Error("model call failed"));
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
      proposedGroup: {
        word_ids: [0, 1, 2, 3],
        category: "Test",
        confidence: 0.9,
        reasoning: "test",
      },
      prompt: "You are solving...",
      model: "test-model",
      contextWindow: 8192,
      latencyMs: 1234,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });

    const res = await solveRequest(SOLVE_BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      proposedGroup: {
        word_ids: [0, 1, 2, 3],
        category: "Test",
        confidence: 0.9,
        reasoning: "test",
      },
      prompt: "You are solving...",
      model: "test-model",
      contextWindow: 8192,
      latencyMs: 1234,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    });
  });

  it("maps duplicate_group to 409", async () => {
    proposeGroupMock.mockRejectedValueOnce(
      new SolveError("duplicate_group", "repeated group", {
        proposedGroup: {
          word_ids: [0, 1, 2, 3],
          category: "Test",
          confidence: 0.9,
          reasoning: "test",
        },
      }),
    );
    const res = await solveRequest(SOLVE_BODY);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("duplicate_group");
    expect((body.details as { proposedGroup: unknown }).proposedGroup).toEqual({
      word_ids: [0, 1, 2, 3],
      category: "Test",
      confidence: 0.9,
      reasoning: "test",
    });
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
});
