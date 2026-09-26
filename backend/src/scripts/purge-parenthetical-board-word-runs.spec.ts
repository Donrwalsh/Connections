import { StrategyRunStatus } from "../modules/strategy/entities/strategy-run.entity";
import {
  AFFECTED_PUZZLE_DATES,
  selectRunsToPurge,
  type CandidateRun,
} from "./purge-parenthetical-board-word-runs";

describe("purge-parenthetical-board-word-runs", () => {
  it("targets exactly the two puzzles whose board words the parser mangled", () => {
    expect(AFFECTED_PUZZLE_DATES).toEqual(["2024-12-12", "2025-04-01"]);
  });

  describe("selectRunsToPurge", () => {
    it("selects every LLM run regardless of status and leaves non-LLM strategies alone", () => {
      const runs: CandidateRun[] = [
        { id: 1, strategyName: "llm-google", status: StrategyRunStatus.COMPLETED },
        { id: 2, strategyName: "llm-openai", status: StrategyRunStatus.FAILED },
        { id: 3, strategyName: "llm-mistral", status: StrategyRunStatus.ERROR },
        { id: 4, strategyName: "alphabetical", status: StrategyRunStatus.COMPLETED },
        { id: 5, strategyName: "shuffle-smart", status: StrategyRunStatus.FAILED },
      ];

      const { toDelete, stillRunning } = selectRunsToPurge(runs);

      expect(toDelete.map((run) => run.id)).toEqual([1, 2, 3]);
      expect(stillRunning).toEqual([]);
    });

    it("reports a still-running LLM run so the purge can refuse to proceed", () => {
      const runs: CandidateRun[] = [
        { id: 1, strategyName: "llm-google", status: StrategyRunStatus.RUNNING },
        { id: 2, strategyName: "llm-google", status: StrategyRunStatus.COMPLETED },
        { id: 3, strategyName: "alphabetical", status: StrategyRunStatus.RUNNING },
      ];

      const { toDelete, stillRunning } = selectRunsToPurge(runs);

      expect(toDelete.map((run) => run.id)).toEqual([1, 2]);
      expect(stillRunning.map((run) => run.id)).toEqual([1]);
    });
  });
});
