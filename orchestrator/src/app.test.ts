import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, SOLVE_BODY_LIMIT } from "./app.js";

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

vi.mock("./solver.js", () => ({
  proposeGroup: vi.fn(async () => {
    throw new Error("model call failed");
  }),
}));

describe("orchestrator app", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_KEY = KEY;
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
    const res = await solveRequest({
      puzzleWords: ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"],
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; details: string };
    expect(body.error).toBe("Solve failed");
    expect(body.details).toContain("model call failed");
  });
});
