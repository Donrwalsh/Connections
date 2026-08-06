import { describe, expect, it } from "vitest";
import { buildSolvePrompt, forbiddenIdSets } from "./prompt.js";
import type { SolveRequest } from "./types.js";

const WORDS = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"];

function makeRequest(overrides: Partial<SolveRequest> = {}): SolveRequest {
  return { puzzleWords: WORDS, priorGuesses: [], ...overrides };
}

describe("forbiddenIdSets", () => {
  it("returns no sets when there are no prior guesses", () => {
    expect(forbiddenIdSets(makeRequest())).toEqual([]);
  });

  it("maps incorrect guess words to sorted IDs", () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["DDDD", "AAAA", "CCCC", "BBBB"], result: "incorrect" },
      ],
    });
    expect(forbiddenIdSets(request)).toEqual([[0, 1, 2, 3]]);
  });

  it("skips resolved (correct) guesses", () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "correct" },
      ],
    });
    expect(forbiddenIdSets(request)).toEqual([]);
  });

  it("omits guesses that reference words no longer in play", () => {
    const request = makeRequest({
      priorGuesses: [
        {
          words: ["AAAA", "BBBB", "CCCC", "GONE"],
          result: "incorrect",
        },
      ],
    });
    expect(forbiddenIdSets(request)).toEqual([]);
  });
});

describe("buildSolvePrompt", () => {
  it("indexes the remaining words and lists a forbidden set", () => {
    const prompt = buildSolvePrompt(
      makeRequest({
        priorGuesses: [
          { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
        ],
      }),
    );

    expect(prompt).toContain("0: AAAA");
    expect(prompt).toContain("FORBIDDEN");
    expect(prompt).toContain("{0,1,2,3}");
  });

  it("omits the forbidden section when nothing is forbidden", () => {
    const prompt = buildSolvePrompt(makeRequest());
    expect(prompt).not.toContain("FORBIDDEN");
  });
});
