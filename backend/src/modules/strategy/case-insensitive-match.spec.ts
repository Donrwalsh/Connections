import { findCaseInsensitiveGroupMatch } from "./case-insensitive-match";

describe("findCaseInsensitiveGroupMatch", () => {
  const answerGroups = [
    ["APPLE", "BANANA", "CHERRY", "DATE"],
    ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
  ];

  it("returns the canonical-case group when the guess matches only after lowercasing", () => {
    const result = findCaseInsensitiveGroupMatch(["apple", "banana", "cherry", "date"], answerGroups);
    expect(result).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
  });

  it("matches regardless of word order within the guess", () => {
    const result = findCaseInsensitiveGroupMatch(["date", "apple", "cherry", "banana"], answerGroups);
    expect(result).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
  });

  it("matches mixed casing, not just fully-lowercase guesses", () => {
    const result = findCaseInsensitiveGroupMatch(["Apple", "BaNaNa", "cherry", "DATE"], answerGroups);
    expect(result).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
  });

  it("returns null for an exact case match — that's not a mismatch", () => {
    const result = findCaseInsensitiveGroupMatch(["APPLE", "BANANA", "CHERRY", "DATE"], answerGroups);
    expect(result).toBeNull();
  });

  it("returns null when no group matches even case-insensitively", () => {
    const result = findCaseInsensitiveGroupMatch(["ocean", "banana", "cherry", "date"], answerGroups);
    expect(result).toBeNull();
  });

  it("returns null when the guess is a different length than every group", () => {
    const result = findCaseInsensitiveGroupMatch(["apple", "banana", "cherry"], answerGroups);
    expect(result).toBeNull();
  });

  it("tolerates surrounding whitespace on the guess words", () => {
    const result = findCaseInsensitiveGroupMatch([" apple ", "banana", "cherry", "date"], answerGroups);
    expect(result).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
  });
});
