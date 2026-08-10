import { describe, expect, it } from "vitest";
import { buildSolvePrompt, forbiddenIdSets, oneAwayIdSets } from "./prompt.js";
import type { SolveRequest } from "./types.js";

const WORDS = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"];

function makeRequest(overrides: Partial<SolveRequest> = {}): SolveRequest {
  return {
    puzzleWords: WORDS,
    priorGuesses: [],
    numResponses: 5,
    temperatureStep: 0.1,
    maxTemperature: 2,
    maxNumResponses: 10,
    maxPrompts: 5,
    ...overrides,
  } as SolveRequest;
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

  it("omits all forbidden guidance when nothing is forbidden", () => {
    const prompt = buildSolvePrompt(makeRequest());

    expect(prompt).not.toContain("FORBIDDEN SETS");
    expect(prompt).not.toContain("Previously attempted");
    expect(prompt).not.toContain("Any candidate set on the forbidden list");
    expect(prompt).not.toContain(
      "No group may match any set in FORBIDDEN SETS",
    );
  });

  it("asks for exactly the configured number of candidate groups", () => {
    const prompt = buildSolvePrompt(makeRequest({ numResponses: 3 }));

    expect(prompt).toContain("Provide exactly 3 distinct candidate groups");
    expect(prompt).toContain("1. Provide exactly 3 distinct candidate groups");
    expect(prompt).toContain('"proposed_groups"');
  });

  it("keeps one-away guidance and lists one-away guesses in their own block", () => {
    const prompt = buildSolvePrompt(
      makeRequest({
        priorGuesses: [
          { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "oneAway" },
        ],
      }),
    );

    expect(prompt).toContain("ONE-AWAY SETS");
    expect(prompt).toContain("- [0, 1, 2, 3]");
    expect(prompt).toContain("do not rely on them exclusively");
    expect(prompt).toContain("CRITICAL SET-THEORY RULES");
    expect(prompt).toContain(
      "No group may match any set in FORBIDDEN SETS (regardless of element order)",
    );
    // The same set is still forbidden to repeat.
    expect(prompt).toContain("FORBIDDEN SETS");
  });

  it("omits one-away guidance when only forbidden sets exist", () => {
    const prompt = buildSolvePrompt(
      makeRequest({
        priorGuesses: [
          { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
        ],
      }),
    );

    // Forbidden guidance stays, one-away guidance disappears.
    expect(prompt).toContain("FORBIDDEN SETS");
    expect(prompt).toContain("Any candidate set on the forbidden list");
    expect(prompt).not.toContain("ONE-AWAY SETS");
    expect(prompt).not.toContain("OVERLAP INFERENCE");
    expect(prompt).not.toContain("CRITICAL SET-THEORY RULES");
    expect(prompt).not.toContain("core triad analysis");
  });

  it("omits forbidden and one-away guidance when the sets reference words no longer in play", () => {
    // "GONE" is not among the remaining words, so any set mentioning it cannot
    // be expressed against the current board and must be dropped entirely —
    // along with every hint, rule and constraint that referenced it.
    const prompt = buildSolvePrompt(
      makeRequest({
        priorGuesses: [
          { words: ["AAAA", "BBBB", "CCCC", "GONE"], result: "incorrect" },
          { words: ["EEEE", "FFFF", "GGGG", "GONE"], result: "oneAway" },
        ],
      }),
    );

    expect(prompt).not.toContain("FORBIDDEN SETS");
    expect(prompt).not.toContain("ONE-AWAY SETS");
    expect(prompt).not.toContain("GONE");
    expect(prompt).not.toContain("OVERLAP INFERENCE");
    expect(prompt).not.toContain("CRITICAL SET-THEORY RULES");
    expect(prompt).not.toContain(
      "No group may match any set in FORBIDDEN SETS",
    );
    // With neither set type in play, the reasoning guidance falls back to plain.
    expect(prompt).toContain(
      '"reasoning": "Explain the category step-by-step."',
    );
  });

  it("keeps only generic guidance when there are no prior guesses", () => {
    const prompt = buildSolvePrompt(makeRequest());

    expect(prompt).toContain("1. Provide exactly 5 distinct candidate groups");
    expect(prompt).not.toContain("one-away");
    expect(prompt).not.toContain("forbidden");
    expect(prompt).toContain(
      '"reasoning": "Explain the category step-by-step."',
    );
  });
});
