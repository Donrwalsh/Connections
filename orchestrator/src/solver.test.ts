import { describe, expect, it } from "vitest";
import { validateProposedGroup } from "./solver.js";
import type { ProposedGroup, SolveRequest } from "./types.js";

const WORDS = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"];

function makeRequest(overrides: Partial<SolveRequest> = {}): SolveRequest {
  return { puzzleWords: WORDS, priorGuesses: [], ...overrides };
}

function makeGroup(overrides: Partial<ProposedGroup> = {}): ProposedGroup {
  return {
    word_ids: [0, 1, 2, 3],
    category: "Test",
    confidence: 0.9,
    reasoning: "test",
    ...overrides,
  };
}

describe("validateProposedGroup", () => {
  it("accepts a valid, unique group of in-range IDs", () => {
    expect(() =>
      validateProposedGroup(makeGroup(), makeRequest()),
    ).not.toThrow();
  });

  it("rejects IDs outside the remaining word list", () => {
    expect(() =>
      validateProposedGroup(
        makeGroup({ word_ids: [0, 1, 2, 99] }),
        makeRequest(),
      ),
    ).toThrow(/not present in the puzzle's remaining word list/);
  });

  it("rejects duplicate IDs", () => {
    expect(() =>
      validateProposedGroup(
        makeGroup({ word_ids: [0, 1, 1, 2] }),
        makeRequest(),
      ),
    ).toThrow(/duplicate word IDs/);
  });

  it("rejects a group that was already guessed", () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
      ],
    });

    // Same four words, different order, must still be caught as a repeat.
    expect(() =>
      validateProposedGroup(makeGroup({ word_ids: [3, 2, 1, 0] }), request),
    ).toThrow(/previously-guessed group/);
  });

  it("does not treat a resolved (correct) guess as forbidden", () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "correct" },
      ],
    });

    expect(() =>
      validateProposedGroup(makeGroup(), request),
    ).not.toThrow();
  });
});
