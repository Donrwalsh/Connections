import { describe, expect, it } from "vitest";
import { parseGroupProposals } from "./solve-assist.js";

describe("parseGroupProposals", () => {
  it("parses a well-formed Words: line", () => {
    const text = "Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n";
    expect(parseGroupProposals(text)).toEqual([
      { category: "Fruits", words: ["APPLE", "BANANA", "CHERRY", "DATE"] },
    ]);
  });

  it("strips a trailing parenthetical explanation glued onto the Words: line", () => {
    // Some models (Mistral especially) append their reasoning straight onto
    // the Words: line instead of using the scratchpad — see
    // llm-strategy-runner.service.ts's WORDS_PARENTHETICAL_RE on the
    // backend, which this parser previously lacked (commit cdd6b22 fixed
    // the backend but not this orchestrator-side parser).
    const text =
      "Group 1\nCategory: Senses\nWords: LOOK, TOUCH, SIGHT, SMELL (these are all senses)\n";
    expect(parseGroupProposals(text)).toEqual([
      { category: "Senses", words: ["LOOK", "TOUCH", "SIGHT", "SMELL"] },
    ]);
  });

  it("discards a group whose parenthetical aside itself contains commas, without the fix inflating it past 4 words", () => {
    const text =
      "Group 1\nCategory: Senses\nWords: LOOK, TOUCH, SIGHT, SMELL (these are all senses, e.g. sight, sound)\n";
    expect(parseGroupProposals(text)).toEqual([
      { category: "Senses", words: ["LOOK", "TOUCH", "SIGHT", "SMELL"] },
    ]);
  });

  it("parses multiple groups from a full ### GROUPS section", () => {
    const text = [
      "### GROUPS",
      "Group 1",
      "Category: Fruits",
      "Words: APPLE, BANANA, CHERRY, DATE",
      "Group 2",
      "Category: Senses",
      "Words: LOOK, TOUCH, SIGHT, SMELL (these are all senses)",
      "### ANSWER",
      "APPLE, BANANA, CHERRY, DATE",
      "LOOK, TOUCH, SIGHT, SMELL",
    ].join("\n");

    expect(parseGroupProposals(text)).toEqual([
      { category: "Fruits", words: ["APPLE", "BANANA", "CHERRY", "DATE"] },
      { category: "Senses", words: ["LOOK", "TOUCH", "SIGHT", "SMELL"] },
    ]);
  });
});
