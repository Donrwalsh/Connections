import { normalizePuzzleWord, applyOneOffWordFixups } from "./normalize-puzzle-word";
import { Puzzle } from "../game/entities/puzzle.entity";
import { StrategyRun } from "./entities/strategy-run.entity";

describe("normalizePuzzleWord", () => {
  it("maps the one-off comma word", () => {
    expect(normalizePuzzleWord("20,000")).toBe("20000");
  });

  it("leaves every other word untouched", () => {
    for (const word of ["20000", "APPLE", "20,001", "1,000", "20, 000"]) {
      expect(normalizePuzzleWord(word)).toBe(word);
    }
  });
});

describe("applyOneOffWordFixups", () => {
  it("rewrites the run's word order and the puzzle's answer members in place", () => {
    const run = {
      availableWords: ["20,000", "BANANA", "CHERRY", "DATE"],
    } as StrategyRun;
    const puzzle = {
      answerGroups: [{ members: [{ word: "20,000" }, { word: "BANANA" }] }],
    } as Puzzle;

    applyOneOffWordFixups(run, puzzle);

    expect(run.availableWords).toEqual(["20000", "BANANA", "CHERRY", "DATE"]);
    expect(puzzle.answerGroups[0].members.map((m) => m.word)).toEqual(["20000", "BANANA"]);
  });

  it("is idempotent on a resumed run", () => {
    const run = { availableWords: ["20000", "BANANA"] } as StrategyRun;
    const puzzle = { answerGroups: [{ members: [{ word: "20000" }] }] } as Puzzle;

    applyOneOffWordFixups(run, puzzle);

    expect(run.availableWords).toEqual(["20000", "BANANA"]);
    expect(puzzle.answerGroups[0].members[0].word).toBe("20000");
  });
});
