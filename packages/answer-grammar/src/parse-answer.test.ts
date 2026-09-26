import { describe, expect, it } from "vitest";
import { formatCompactAnswer, parseAnswer } from "./parse-answer";

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

  it("flags multipleProposals when the response contains more than one ### ANSWER block", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE\n\n" +
      "Actually, let me reconsider.\n\n" +
      "### GROUPS\n#### Group 1\nCategory: Colors\nWords: RED, BLUE, GREEN, YELLOW\n\n" +
      "### ANSWER\nRED, BLUE, GREEN, YELLOW";
    const result = parseAnswer(response);

    expect(result.textIssues).toEqual(["multipleProposals"]);
  });

  it("does not flag multipleProposals for a single ### ANSWER block", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n\n" +
      "### ANSWER\nAPPLE, BANANA, CHERRY, DATE";
    const result = parseAnswer(response);

    expect(result.textIssues).toEqual([]);
  });
});

describe("parseAnswer with boardWords", () => {
  // 2024-12-12 is an image puzzle whose card alt text itself carries
  // parentheticals.
  const teeBoard = [
    "TEA", "TEE (GOLF)", "TEE (SHIRT)", "TI (MUSICAL NOTE)",
    "COMB", "GEAR", "SAW", "ZIPPER",
  ];
  // 2025-04-01's "EMOTICON MOUTHS" group has literal "(" and ")" cards.
  const emoticonBoard = ["(", ")", "O", "P", "$", "€", "£", "¥"];

  it("keeps a board word's own parenthetical and does not flag parentheticalStripped", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Sounds like T\n" +
      "Words: TEA, TEE (GOLF), TEE (SHIRT), TI (MUSICAL NOTE)\n\n" +
      "### ANSWER\nTEA, TEE (GOLF), TEE (SHIRT), TI (MUSICAL NOTE)";
    const result = parseAnswer(response, teeBoard);

    expect(result.proposalWords).toEqual([["TEA", "TEE (GOLF)", "TEE (SHIRT)", "TI (MUSICAL NOTE)"]]);
    expect(result.groups).toEqual([["TEA", "TEE (GOLF)", "TEE (SHIRT)", "TI (MUSICAL NOTE)"]]);
    expect(result.textIssues).toEqual([]);
  });

  it("still strips a trailing aside that follows a protected board word", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Sounds like T\n" +
      "Words: TEA, TEE (GOLF), TEE (SHIRT), TI (MUSICAL NOTE) (homophones, all of them)\n\n" +
      "### ANSWER\nTEA, TEE (GOLF), TEE (SHIRT), TI (MUSICAL NOTE)";
    const result = parseAnswer(response, teeBoard);

    expect(result.proposalWords).toEqual([["TEA", "TEE (GOLF)", "TEE (SHIRT)", "TI (MUSICAL NOTE)"]]);
    expect(result.textIssues).toEqual(["parentheticalStripped"]);
  });

  it("protects board words case-insensitively but keeps the model's own casing", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Sounds like T\n" +
      "Words: Tea, Tee (golf), Tee (shirt), Ti (musical note)\n\n" +
      "### ANSWER\nTea, Tee (golf), Tee (shirt), Ti (musical note)";
    const result = parseAnswer(response, teeBoard);

    expect(result.proposalWords).toEqual([["Tea", "Tee (golf)", "Tee (shirt)", "Ti (musical note)"]]);
    expect(result.textIssues).toEqual([]);
  });

  it("protects a board word wrapped in markdown emphasis", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Sounds like T\n" +
      "Words: **TEA**, **TEE (GOLF)**, `TEE (SHIRT)`, TI (MUSICAL NOTE)\n\n" +
      "### ANSWER\nTEA, TEE (GOLF), TEE (SHIRT), TI (MUSICAL NOTE)";
    const result = parseAnswer(response, teeBoard);

    expect(result.proposalWords).toEqual([["TEA", "TEE (GOLF)", "TEE (SHIRT)", "TI (MUSICAL NOTE)"]]);
    expect(result.textIssues).toEqual([]);
  });

  it("keeps literal ( and ) cards instead of stripping them as one parenthetical", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Emoticon mouths\nWords: (, ), O, P\n\n" +
      "### ANSWER\n(, ), O, P";
    const result = parseAnswer(response, emoticonBoard);

    expect(result.proposalWords).toEqual([["(", ")", "O", "P"]]);
    expect(result.groups).toEqual([["(", ")", "O", "P"]]);
    expect(result.textIssues).toEqual([]);
  });

  it("does not treat a lone ( board word as protecting the start of an aside", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Currency\nWords: $, €, £, ¥ (currency signs)\n\n" +
      "### ANSWER\n$, €, £, ¥";
    const result = parseAnswer(response, emoticonBoard);

    expect(result.proposalWords).toEqual([["$", "€", "£", "¥"]]);
    expect(result.textIssues).toEqual(["parentheticalStripped"]);
  });

  it("keeps a hyphenated board word intact in the ANSWER block while still stripping bullets", () => {
    const response = "### ANSWER\n- YO-YO, KITE, TOP, JACKS";
    const result = parseAnswer(response, ["YO-YO", "KITE", "TOP", "JACKS"]);

    expect(result.groups).toEqual([["YO-YO", "KITE", "TOP", "JACKS"]]);
    expect(result.proposalWords).toEqual([["YO-YO", "KITE", "TOP", "JACKS"]]);
  });

  it("still strips hyphens in the ANSWER block when no boardWords are given", () => {
    const response = "### ANSWER\nYO-YO, KITE, TOP, JACKS";
    const result = parseAnswer(response);

    expect(result.groups).toEqual([["YOYO", "KITE", "TOP", "JACKS"]]);
  });

  it("strips the board word's parenthetical like any aside when boardWords is omitted", () => {
    const response =
      "### GROUPS\n#### Group 1\nCategory: Sounds like T\n" +
      "Words: TEA, TEE (GOLF), TEE (SHIRT), TI (MUSICAL NOTE)\n\n" +
      "### ANSWER\nTEA, TEE (GOLF), TEE (SHIRT), TI (MUSICAL NOTE)";
    const result = parseAnswer(response);

    expect(result.proposalWords).toEqual([["TEA", "TEE", "TEE", "TI"]]);
    expect(result.textIssues).toEqual(["parentheticalStripped"]);
  });
});

describe("formatCompactAnswer", () => {
  it("rebuilds a compact GROUPS/ANSWER block from the parsed proposal data", () => {
    const proposalWords = [
      ["APPLE", "BANANA", "CHERRY", "DATE"],
      ["RED", "BLUE", "GREEN", "YELLOW"],
    ];
    const categoryByGroup = new Map([
      [1, "Fruits"],
      [2, "Colors"],
    ]);

    const compact = formatCompactAnswer(proposalWords, categoryByGroup);

    expect(compact).toBe(
      "### GROUPS\n" +
        "Group 1\n" +
        "Category: Fruits\n" +
        "Words: APPLE, BANANA, CHERRY, DATE\n\n" +
        "Group 2\n" +
        "Category: Colors\n" +
        "Words: RED, BLUE, GREEN, YELLOW\n\n" +
        "### ANSWER\n" +
        "APPLE, BANANA, CHERRY, DATE\n" +
        "RED, BLUE, GREEN, YELLOW",
    );
  });

  it("skips a sparse hole in proposalWords rather than rendering an empty group", () => {
    const proposalWords = [undefined as unknown as string[], ["RED", "BLUE", "GREEN", "YELLOW"]];
    const categoryByGroup = new Map([[2, "Colors"]]);

    const compact = formatCompactAnswer(proposalWords, categoryByGroup);

    expect(compact).toBe(
      "### GROUPS\nGroup 2\nCategory: Colors\nWords: RED, BLUE, GREEN, YELLOW\n\n### ANSWER\nRED, BLUE, GREEN, YELLOW",
    );
  });

  it("omits the Category line when a group number has no known category", () => {
    const proposalWords = [["APPLE", "BANANA", "CHERRY", "DATE"]];
    const categoryByGroup = new Map<number, string>();

    const compact = formatCompactAnswer(proposalWords, categoryByGroup);

    expect(compact).toBe(
      "### GROUPS\nGroup 1\nWords: APPLE, BANANA, CHERRY, DATE\n\n### ANSWER\nAPPLE, BANANA, CHERRY, DATE",
    );
  });
});
