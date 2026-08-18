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

vi.mock("./assist.js", () => ({
  runAssistStep: vi.fn(async () => {
    throw new Error("model call failed");
  }),
}));

vi.mock("./solve-assist.js", () => ({
  solveAssist: vi.fn(async () => {
    throw new Error("model call failed");
  }),
}));

import { runAssistStep } from "./assist.js";
import { solveAssist } from "./solve-assist.js";
const runAssistStepMock = vi.mocked(runAssistStep);
const solveAssistMock = vi.mocked(solveAssist);

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

function solveAssistRequest(body: unknown) {
  return app.request("/solve-assist", {
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
    runAssistStepMock.mockReset();
    runAssistStepMock.mockRejectedValue(new Error("model call failed"));
    solveAssistMock.mockReset();
    solveAssistMock.mockRejectedValue(new Error("model call failed"));
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

  describe("POST /solve-assist", () => {
    const SOLVE_ASSIST_BODY = {
      messages: [{ role: "user", content: "Analyze the 16 provided items..." }],
      model: "gpt-4.1-nano-2025-04-14",
      provider: "openai",
    };

    it("passes model and provider through to solveAssist", async () => {
      solveAssistMock.mockResolvedValueOnce({
        response: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
        groups: [["AAAA", "BBBB", "CCCC", "DDDD"]],
        proposals: [],
        model: "gpt-4.1-nano-2025-04-14",
        latencyMs: 5,
      });

      const res = await solveAssistRequest(SOLVE_ASSIST_BODY);

      expect(res.status).toBe(200);
      expect(solveAssistMock).toHaveBeenCalledWith(
        SOLVE_ASSIST_BODY.messages,
        "gpt-4.1-nano-2025-04-14",
        "openai",
      );
    });

    it("works without model/provider (falls back to the env-configured default)", async () => {
      solveAssistMock.mockResolvedValueOnce({
        response: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
        groups: [["AAAA", "BBBB", "CCCC", "DDDD"]],
        proposals: [],
        model: "gpt-4.1-nano",
        latencyMs: 5,
      });

      const res = await solveAssistRequest({ messages: SOLVE_ASSIST_BODY.messages });

      expect(res.status).toBe(200);
      expect(solveAssistMock).toHaveBeenCalledWith(SOLVE_ASSIST_BODY.messages, undefined, undefined);
    });

    it("rejects an unknown provider value", async () => {
      const res = await solveAssistRequest({
        messages: SOLVE_ASSIST_BODY.messages,
        provider: "anthropic",
      });

      expect(res.status).toBe(400);
      expect(solveAssistMock).not.toHaveBeenCalled();
    });
  });
});
