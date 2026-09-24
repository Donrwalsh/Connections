import { findCaseMismatchAffectedRunIds, type CaseMismatchProposalRow } from "./purge-case-mismatch-runs";

describe("findCaseMismatchAffectedRunIds", () => {
  const answerGroupsByPuzzleId = new Map<number, string[][]>([
    [
      100,
      [
        ["APPLE", "BANANA", "CHERRY", "DATE"],
        ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
      ],
    ],
  ]);

  it("flags a run whose not_selected proposal matches a puzzle group only after lowercasing", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 100, words: ["apple", "banana", "cherry", "date"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, answerGroupsByPuzzleId)).toEqual(new Set([7]));
  });

  it("does not flag a run whose proposal genuinely has no matching group (real hallucination)", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 100, words: ["ocean", "banana", "cherry", "date"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, answerGroupsByPuzzleId)).toEqual(new Set());
  });

  it("does not flag a run whose proposal already matches exactly (not a case mismatch)", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 100, words: ["APPLE", "BANANA", "CHERRY", "DATE"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, answerGroupsByPuzzleId)).toEqual(new Set());
  });

  it("skips a proposal whose puzzle has no known answer groups", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 999, words: ["apple", "banana", "cherry", "date"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, new Map())).toEqual(new Set());
  });

  it("collects multiple distinct affected run ids and dedupes repeats from the same run", () => {
    const proposals: CaseMismatchProposalRow[] = [
      { strategyRunId: 7, puzzleId: 100, words: ["apple", "banana", "cherry", "date"] },
      { strategyRunId: 7, puzzleId: 100, words: ["apple", "banana", "cherry", "date"] },
      { strategyRunId: 8, puzzleId: 100, words: ["eggplant", "fig", "grape", "honey"] },
    ];
    expect(findCaseMismatchAffectedRunIds(proposals, answerGroupsByPuzzleId)).toEqual(new Set([7, 8]));
  });
});
