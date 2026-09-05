import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_SESSION_EXPIRED_EVENT,
  deleteErroredRuns,
  deleteFailedJudgeCalls,
  fetchErroredRunCount,
  fetchFailedJudgeCallCount,
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
