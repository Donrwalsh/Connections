import { SolvePromptStatus } from "../modules/strategy/entities/solve-prompt.entity";
import type { SolvePrompt } from "../modules/strategy/entities/solve-prompt.entity";
import { findManualRetryHistoryLoss } from "./find-manual-retry-history-loss";

type Row = Pick<SolvePrompt, "promptNumber" | "status" | "manualRetry" | "requestBody">;

function makeRow(overrides: Partial<Row>): Row {
  return {
    promptNumber: 0,
    status: SolvePromptStatus.PARSED,
    manualRetry: false,
    requestBody: null,
    ...overrides,
  };
}

const chatMessages = [{ role: "user", content: "solve this puzzle" }];

describe("findManualRetryHistoryLoss", () => {
  it("returns null when there are no rows", () => {
    expect(findManualRetryHistoryLoss([])).toBeNull();
  });

  it("returns null for a run with no manual retry at all", () => {
    const rows = [
      makeRow({ promptNumber: 1, status: SolvePromptStatus.PARSED }),
      makeRow({ promptNumber: 2, status: SolvePromptStatus.CALL_ERROR }),
    ];

    expect(findManualRetryHistoryLoss(rows)).toBeNull();
  });

  it("flags a manual retry whose trigger CALL_ERROR row has no requestBody, after a real prior successful call", () => {
    const rows = [
      makeRow({ promptNumber: 1, status: SolvePromptStatus.PARSED }),
      makeRow({ promptNumber: 2, status: SolvePromptStatus.CALL_ERROR, requestBody: null }),
      makeRow({ promptNumber: 3, manualRetry: true, status: SolvePromptStatus.PARSED }),
    ];

    const result = findManualRetryHistoryLoss(rows);

    expect(result).toEqual({ triggerPromptNumber: 2, retryPromptNumber: 3 });
  });

  it("does not flag a manual retry whose trigger row's requestBody has a reconstructable message history", () => {
    const rows = [
      makeRow({ promptNumber: 1, status: SolvePromptStatus.PARSED }),
      makeRow({
        promptNumber: 2,
        status: SolvePromptStatus.CALL_ERROR,
        requestBody: { messages: chatMessages },
      }),
      makeRow({ promptNumber: 3, manualRetry: true, status: SolvePromptStatus.PARSED }),
    ];

    expect(findManualRetryHistoryLoss(rows)).toBeNull();
  });

  it("does not flag a manual retry when nothing before the trigger row ever succeeded (nothing real to lose)", () => {
    const rows = [
      // The run's very first call failed outright — its own turn was popped
      // from history immediately, the same way a live run pops it, so a
      // correct reconstruction would have been empty anyway.
      makeRow({ promptNumber: 1, status: SolvePromptStatus.CALL_ERROR, requestBody: null }),
      makeRow({ promptNumber: 2, manualRetry: true, status: SolvePromptStatus.PARSED }),
    ];

    expect(findManualRetryHistoryLoss(rows)).toBeNull();
  });

  it("does not flag a manual retry when a run's trigger row genuinely has no earlier row at all", () => {
    const rows = [makeRow({ promptNumber: 1, manualRetry: true, status: SolvePromptStatus.PARSED })];

    expect(findManualRetryHistoryLoss(rows)).toBeNull();
  });

  it("uses the first manual retry row when a run was retried more than once", () => {
    const rows = [
      makeRow({ promptNumber: 1, status: SolvePromptStatus.PARSED }),
      makeRow({ promptNumber: 2, status: SolvePromptStatus.CALL_ERROR, requestBody: null }),
      makeRow({ promptNumber: 3, manualRetry: true, status: SolvePromptStatus.CALL_ERROR, requestBody: null }),
      makeRow({ promptNumber: 4, manualRetry: true, status: SolvePromptStatus.PARSED }),
    ];

    const result = findManualRetryHistoryLoss(rows);

    expect(result).toEqual({ triggerPromptNumber: 2, retryPromptNumber: 3 });
  });
});
