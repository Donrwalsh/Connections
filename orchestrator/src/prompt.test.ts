import { describe, expect, it } from "vitest";
import { buildSolvePrompt, forbiddenIdSets, oneAwayIdSets } from "./prompt.js";
import type { SolveRequest } from "./types.js";

const WORDS = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"];

function makeRequest(overrides: Partial<SolveRequest> = {}): SolveRequest {
  return { puzzleWords: WORDS, priorGuesses: [], numResponses: 5, ...overrides };
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

  it("keeps one-away guesses in the forbidden sets", () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "oneAway" },
      ],
    });
    expect(forbiddenIdSets(request)).toEqual([[0, 1, 2, 3]]);
  });
});

describe("oneAwayIdSets", () => {
  it("returns no sets when there are no one-away guesses", () => {
    expect(oneAwayIdSets(makeRequest())).toEqual([]);
  });

  it("maps only one-away guesses to sorted IDs", () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "oneAway" },
        { words: ["AAAA", "BBBB", "EEEE", "FFFF"], result: "incorrect" },
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "correct" },
      ],
    });
    expect(oneAwayIdSets(request)).toEqual([[0, 1, 2, 3]]);
  });

  it("omits one-away guesses that reference words no longer in play", () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "GONE"], result: "oneAway" },
      ],
    });
    expect(oneAwayIdSets(request)).toEqual([]);
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
    expect(prompt).toContain("- [0, 1, 2, 3]");
  });

  it("omits the forbidden section when nothing is forbidden", () => {
    const prompt = buildSolvePrompt(makeRequest());
    // The static constraints always reference the FORBIDDEN SETS concept,
    // but the "Previously attempted" section itself must be absent.
    expect(prompt).not.toContain("Previously attempted");
  });

  it("asks for exactly the configured number of candidate groups", () => {
    const prompt = buildSolvePrompt(makeRequest({ numResponses: 3 }));

    expect(prompt).toContain("Propose exactly 3 DISTINCT candidate groups");
    expect(prompt).toContain("1. Provide exactly 3 groups.");
    expect(prompt).toContain('"proposed_groups"');
  });

  it("lists one-away guesses in their own block with a usage hint", () => {
    const prompt = buildSolvePrompt(
      makeRequest({
        priorGuesses: [
          { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "oneAway" },
        ],
      }),
    );

    expect(prompt).toContain("ONE-AWAY SETS");
    expect(prompt).toContain("Exactly 3 of the 4 words are correct");
    expect(prompt).toContain("- [0, 1, 2, 3]");
    // The hint tells the model to keep 3 words together and swap the fourth.
    expect(prompt).toContain("Keep 3 words from a ONE-AWAY SET together");
    expect(prompt).toContain("Leverage every ONE-AWAY SET");
    // The same set is still forbidden to repeat.
    expect(prompt).toContain("FORBIDDEN SETS");
  });

  it("omits the one-away block and hint when there are no one-away guesses", () => {
    const prompt = buildSolvePrompt(
      makeRequest({
        priorGuesses: [
          { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
        ],
      }),
    );

    // The static constraints reference the ONE-AWAY SETS concept, but the
    // guess list and the hint section themselves must be absent.
    expect(prompt).not.toContain("ONE-AWAY SETS (Exactly 3 of the 4 words are correct");
    expect(prompt).not.toContain("HINT: In each ONE-AWAY SET");
  });
});
