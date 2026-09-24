import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_SESSION_EXPIRED_EVENT,
  deleteErroredRuns,
  deleteErroredRunsForStrategy,
  deleteFailedJudgeCalls,
  fetchErroredRunCount,
  fetchErroredRunCountForStrategy,
  fetchFailedJudgeCallCount,
  fetchRecentActivity,
  retryErroredRunsForStrategy,
  retryRun,
  toRunRecord,
} from "./api";
import type { StrategyRunListItem } from "./types";

function makeItem(overrides: Partial<StrategyRunListItem> = {}): StrategyRunListItem {
  return {
    id: 1,
    strategyName: "llm-openai",
    trialNumber: 0,
    status: "completed",
    modelName: "gpt-4.1-nano",
    contextWindow: null,
    startedAt: "2024-01-01T00:00:00Z",
    finishedAt: "2024-01-01T03:00:00Z",
    solveDurationMs: null,
    guessCount: 4,
    ...overrides,
  };
}

describe("toRunRecord", () => {
  it("uses solveDurationMs for durationMs when the backend provides it", () => {
    const record = toRunRecord(makeItem({ solveDurationMs: 6000 }));

    // Not the 3-hour wall-clock span between startedAt and finishedAt.
    expect(record.durationMs).toBe(6000);
  });

  it("falls back to wall-clock when solveDurationMs is null (deterministic run)", () => {
    const record = toRunRecord(
      makeItem({
        strategyName: "shuffle-smart",
        modelName: null,
        startedAt: "2024-01-01T00:00:00Z",
        finishedAt: "2024-01-01T00:00:05Z",
        solveDurationMs: null,
      }),
    );

    expect(record.durationMs).toBe(5000);
  });

  it("keeps a real 0ms sum rather than falling back to wall-clock", () => {
    const record = toRunRecord(makeItem({ solveDurationMs: 0 }));

    expect(record.durationMs).toBe(0);
  });
});

function stubFetch(body: unknown) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Promise.resolve({ ok: true, json: async () => body });
    }),
  );
  return calls;
}

function stubFetchError(status: number, message: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: false, status, json: async () => ({ message }) })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchRecentActivity", () => {
  const feed = { runs: [], judgments: [] };

  it("GETs /strategy/activity/recent with no provider param when no pools are selected", async () => {
    const calls = stubFetch(feed);

    const result = await fetchRecentActivity();

    expect(result).toEqual(feed);
    expect(calls[0].url).toContain("/strategy/activity/recent");
    expect(calls[0].url).not.toContain("provider=");
  });

  it("passes the selected pools as a comma-separated provider query param", async () => {
    const calls = stubFetch(feed);

    await fetchRecentActivity(undefined, ["groq", "openrouter"]);

    expect(calls[0].url).toContain("provider=groq%2Copenrouter");
  });

  it("omits the provider param for an empty pool list", async () => {
    const calls = stubFetch(feed);

    await fetchRecentActivity(undefined, []);

    expect(calls[0].url).not.toContain("provider=");
  });
});

describe("maintenance-panel API", () => {
  describe("fetchErroredRunCount", () => {
    it("GETs /dispatch/runs/errored and returns the count payload", async () => {
      const calls = stubFetch({ erroredRuns: 5 });

      const result = await fetchErroredRunCount();

      expect(result).toEqual({ erroredRuns: 5 });
      expect(calls[0].url).toContain("/dispatch/runs/errored");
      expect(calls[0].init?.method ?? "GET").toBe("GET");
    });
  });

  describe("deleteErroredRuns", () => {
    it("DELETEs /dispatch/runs/errored with credentials and the admin header", async () => {
      const calls = stubFetch({
        message: "Deleted 2 errored strategy run(s) and all related data",
        deletedRuns: 2,
        deletedGuesses: 11,
        deletedSolvePrompts: 22,
        deletedLlmProposals: 33,
        deletedCategoryEvaluations: 44,
      });

      const result = await deleteErroredRuns();

      expect(result.deletedRuns).toBe(2);
      expect(calls[0].url).toContain("/dispatch/runs/errored");
      expect(calls[0].init?.method).toBe("DELETE");
      expect(calls[0].init?.credentials).toBe("include");
      expect((calls[0].init?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
    });

    it("rejects with a session-expired message and fires ADMIN_SESSION_EXPIRED_EVENT on a 403", async () => {
      stubFetchError(403, "Invalid or missing dispatch password.");
      const handler = vi.fn();
      window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);

      await expect(deleteErroredRuns()).rejects.toThrow("Session expired");
      expect(handler).toHaveBeenCalledOnce();

      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);
    });
  });

  describe("retryRun", () => {
    it("POSTs /dispatch/run/:runId/retry with credentials and the admin header", async () => {
      const calls = stubFetch({
        message: "Strategy run 42 requeued for manual retry",
        runId: 42,
        status: "running",
      });

      const result = await retryRun(42);

      expect(result.status).toBe("running");
      expect(calls[0].url).toContain("/dispatch/run/42/retry");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.credentials).toBe("include");
      expect((calls[0].init?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
    });

    it("rejects with a session-expired message and fires ADMIN_SESSION_EXPIRED_EVENT on a 403", async () => {
      stubFetchError(403, "Invalid or missing dispatch password.");
      const handler = vi.fn();
      window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);

      await expect(retryRun(42)).rejects.toThrow("Session expired");
      expect(handler).toHaveBeenCalledOnce();

      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);
    });
  });

  describe("fetchErroredRunCountForStrategy", () => {
    it("GETs /dispatch/strategy/:strategyName/runs/errored and returns the count payload", async () => {
      const calls = stubFetch({ erroredRuns: 3 });

      const result = await fetchErroredRunCountForStrategy("llm-openai");

      expect(result).toEqual({ erroredRuns: 3 });
      expect(calls[0].url).toContain("/dispatch/strategy/llm-openai/runs/errored");
      expect(calls[0].init?.method ?? "GET").toBe("GET");
    });

    it("adds a model query param when given, so one LLM strategy's many models don't get mixed up", async () => {
      const calls = stubFetch({ erroredRuns: 22 });

      await fetchErroredRunCountForStrategy("llm-google", "gemini-3.1-flash-lite");

      expect(calls[0].url).toContain("/dispatch/strategy/llm-google/runs/errored");
      expect(calls[0].url).toContain("model=gemini-3.1-flash-lite");
    });
  });

  describe("deleteErroredRunsForStrategy", () => {
    it("DELETEs /dispatch/strategy/:strategyName/runs/errored with credentials and the admin header", async () => {
      const calls = stubFetch({
        message: "Deleted 2 errored strategy run(s) for 'llm-openai' and all related data",
        strategyName: "llm-openai",
        deletedRuns: 2,
        deletedGuesses: 11,
        deletedSolvePrompts: 22,
        deletedLlmProposals: 33,
        deletedCategoryEvaluations: 44,
      });

      const result = await deleteErroredRunsForStrategy("llm-openai");

      expect(result.deletedRuns).toBe(2);
      expect(calls[0].url).toContain("/dispatch/strategy/llm-openai/runs/errored");
      expect(calls[0].init?.method).toBe("DELETE");
      expect(calls[0].init?.credentials).toBe("include");
      expect((calls[0].init?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
    });

    it("adds a model query param when given", async () => {
      const calls = stubFetch({
        message: "Deleted 22 errored strategy run(s) for 'llm-google' model 'gemini-3.1-flash-lite' and all related data",
        strategyName: "llm-google",
        deletedRuns: 22,
        deletedGuesses: 0,
        deletedSolvePrompts: 0,
        deletedLlmProposals: 0,
        deletedCategoryEvaluations: 0,
      });

      await deleteErroredRunsForStrategy("llm-google", "gemini-3.1-flash-lite");

      expect(calls[0].url).toContain("/dispatch/strategy/llm-google/runs/errored");
      expect(calls[0].url).toContain("model=gemini-3.1-flash-lite");
      expect(calls[0].init?.method).toBe("DELETE");
    });

    it("rejects with a session-expired message and fires ADMIN_SESSION_EXPIRED_EVENT on a 403", async () => {
      stubFetchError(403, "Invalid or missing dispatch password.");
      const handler = vi.fn();
      window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);

      await expect(deleteErroredRunsForStrategy("llm-openai")).rejects.toThrow("Session expired");
      expect(handler).toHaveBeenCalledOnce();

      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);
    });
  });

  describe("retryErroredRunsForStrategy", () => {
    it("POSTs /dispatch/strategy/:strategyName/runs/errored/retry with credentials and the admin header", async () => {
      const calls = stubFetch({
        message: "Queued 2 errored strategy run(s) for 'llm-openai' for manual retry",
        strategyName: "llm-openai",
        retried: 2,
        skipped: 0,
        failed: 0,
        failures: [],
      });

      const result = await retryErroredRunsForStrategy("llm-openai");

      expect(result.retried).toBe(2);
      expect(calls[0].url).toContain("/dispatch/strategy/llm-openai/runs/errored/retry");
      expect(calls[0].init?.method).toBe("POST");
      expect(calls[0].init?.credentials).toBe("include");
      expect((calls[0].init?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
    });

    it("adds a model query param when given", async () => {
      const calls = stubFetch({
        message: "Queued 22 errored strategy run(s) for 'llm-google' model 'gemini-3.1-flash-lite' for manual retry",
        strategyName: "llm-google",
        retried: 22,
        skipped: 0,
        failed: 0,
        failures: [],
      });

      await retryErroredRunsForStrategy("llm-google", "gemini-3.1-flash-lite");

      expect(calls[0].url).toContain("/dispatch/strategy/llm-google/runs/errored/retry");
      expect(calls[0].url).toContain("model=gemini-3.1-flash-lite");
      expect(calls[0].init?.method).toBe("POST");
    });

    it("rejects with a session-expired message and fires ADMIN_SESSION_EXPIRED_EVENT on a 403", async () => {
      stubFetchError(403, "Invalid or missing dispatch password.");
      const handler = vi.fn();
      window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);

      await expect(retryErroredRunsForStrategy("llm-openai")).rejects.toThrow("Session expired");
      expect(handler).toHaveBeenCalledOnce();

      window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handler);
    });
  });

  describe("fetchFailedJudgeCallCount", () => {
    it("GETs /category-evaluation/failed and returns the count payload", async () => {
      const calls = stubFetch({ failed: 7 });

      const result = await fetchFailedJudgeCallCount();

      expect(result).toEqual({ failed: 7 });
      expect(calls[0].url).toContain("/category-evaluation/failed");
      expect(calls[0].init?.method ?? "GET").toBe("GET");
    });
  });

  describe("deleteFailedJudgeCalls", () => {
    it("DELETEs /category-evaluation/failed with credentials and the admin header", async () => {
      const calls = stubFetch({
        message: "Deleted 7 failed judge call(s); the next dispatch will re-judge them",
        deleted: 7,
      });

      const result = await deleteFailedJudgeCalls();

      expect(result.deleted).toBe(7);
      expect(calls[0].url).toContain("/category-evaluation/failed");
      expect(calls[0].init?.method).toBe("DELETE");
      expect(calls[0].init?.credentials).toBe("include");
      expect((calls[0].init?.headers as Record<string, string>)["X-Admin-Request"]).toBe("1");
    });
  });
});
