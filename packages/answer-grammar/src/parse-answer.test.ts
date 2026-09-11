import { describe, expect, it } from "vitest";
import { parseAnswer } from "./parse-answer";

describe("parseAnswer", () => {
  it("parses a clean response into groups, proposalWords and categories", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.groups).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
    expect(result.proposalWords).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
    expect(result.categoryByGroup.get(1)).toBe("Fruits");
    expect(result.textIssues).toEqual([]);
  });

  it("flags parentheticalStripped and strips the aside from the words line", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\n" +
      "Words: APPLE, BANANA, CHERRY, DATE (these are all fruits)\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.proposalWords).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
    expect(result.textIssues).toEqual(["parentheticalStripped"]);
  });

  it("does not flag parentheticalStripped when the words line has no aside", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.textIssues).toEqual([]);
  });

  it("does not let a global regex's stateful lastIndex leak parentheticalStripped across calls", () => {
    const withParenthetical =
      "### GROUPS\n#### Group 1\nCategory: Fruits\n" +
      "Words: EGGPLANT, FIG, GRAPE, HONEY (a tasty aside)\n\n### ANSWER\nEGGPLANT, FIG, GRAPE, HONEY";
    const withoutParenthetical =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";

    parseAnswer(withParenthetical);
    const second = parseAnswer(withoutParenthetical);

    expect(second.textIssues).toEqual([]);
  });

  it("flags groupCountOff when a Words: line splits to the wrong count, and still returns the group that parsed fine", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY\n\n" +
      "#### Group 2\nCategory: Misc\nWords: EGGPLANT, FIG, GRAPE, HONEY\n\n" +
      "### ANSWER\nEGGPLANT, FIG, GRAPE, HONEY";
    const result = parseAnswer(response);

    expect(result.proposalWords).toEqual([undefined, ["EGGPLANT", "FIG", "GRAPE", "HONEY"]]);
    expect(result.textIssues).toEqual(["groupCountOff"]);
  });

  it("still flags groupCountOff and falls back to the ANSWER block when every GROUPS entry has the wrong word count", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.proposalWords).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
    expect(result.textIssues).toEqual(["groupCountOff"]);
  });

  it("flags unclassified when a group heading has no matching Words: line at all", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
      "#### Group 2\nCategory: Misc\n\n### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.textIssues).toEqual(["unclassified"]);
  });

  it("flags unclassified even when parsedGroupWords ends up empty (single heading, no Words: line)", () => {
    const response = "### GROUPS\n#### Group 1\nCategory: Fruits\n\n### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.textIssues).toEqual(["unclassified"]);
    expect(result.proposalWords).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
  });

  it("never flags unclassified for a group number the response's own headings never mention", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.textIssues).toEqual([]);
  });

  it("falls back proposalWords to the ANSWER block verbatim when the ### GROUPS section is missing entirely", () => {
    const response = "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.groups).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
    expect(result.proposalWords).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
    expect(result.textIssues).toEqual([]);
    expect(result.categoryByGroup.size).toBe(0);
  });

  it("falls back groups to the GROUPS block's words when the ANSWER block is missing entirely", () => {
    const response = "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n";
    const result = parseAnswer(response);

    expect(result.groups).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
  });

  it("strips markdown emphasis characters from GROUPS words", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: **APPLE**, `BANANA`, CHERRY, DATE\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.proposalWords).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
  });

  it("strips markdown characters from ANSWER block lines", () => {
    const response = "### ANSWER\n**APPLE**, `BANANA`, #CHERRY, -DATE";
    const result = parseAnswer(response);

    expect(result.groups).toEqual([["APPLE", "BANANA", "CHERRY", "DATE"]]);
  });

  it("keys categoryByGroup by the response's own group numbers, even out of order", () => {
    const response =
      "### GROUPS\n#### Group 2\nCategory: Misc\nWords: EGGPLANT, FIG, GRAPE, HONEY\n\n" +
      "#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE\nEGGPLANT, FIG, GRAPE, HONEY";
    const result = parseAnswer(response);

    expect(result.categoryByGroup.get(1)).toBe("Fruits");
    expect(result.categoryByGroup.get(2)).toBe("Misc");
    expect(result.proposalWords).toEqual([
      ["APPLE", "BANANA", "CHERRY", "DATE"],
      ["EGGPLANT", "FIG", "GRAPE", "HONEY"],
    ]);
  });

  it("returns empty groups when there is no ANSWER block and no GROUPS block", () => {
    const result = parseAnswer("I don't know the answer");

    expect(result.groups).toEqual([]);
    expect(result.proposalWords).toEqual([]);
  });
});
