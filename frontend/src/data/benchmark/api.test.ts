import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteErroredRuns,
  deleteFailedJudgeCalls,
  fetchErroredRunCount,
  fetchFailedJudgeCallCount,
} from "./api";

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
    it("sends the password to DELETE /dispatch/runs/errored", async () => {
      const calls = stubFetch({
        message: "Deleted 2 errored strategy run(s) and all related data",
        deletedRuns: 2,
        deletedGuesses: 11,
        deletedSolvePrompts: 22,
        deletedLlmProposals: 33,
        deletedCategoryEvaluations: 44,
      });

      const result = await deleteErroredRuns("hunter2");

      expect(result.deletedRuns).toBe(2);
      expect(calls[0].url).toContain("/dispatch/runs/errored");
      expect(calls[0].init?.method).toBe("DELETE");
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ password: "hunter2" });
    });

    it("rejects with the backend message on a failure", async () => {
      stubFetchError(401, "Bad password");

      await expect(deleteErroredRuns("nope")).rejects.toThrow("Bad password");
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
    it("sends the password to DELETE /category-evaluation/failed", async () => {
      const calls = stubFetch({
        message: "Deleted 7 failed judge call(s); the next dispatch will re-judge them",
        deleted: 7,
      });

      const result = await deleteFailedJudgeCalls("hunter2");

      expect(result.deleted).toBe(7);
      expect(calls[0].url).toContain("/category-evaluation/failed");
      expect(calls[0].init?.method).toBe("DELETE");
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ password: "hunter2" });
    });
  });
});
