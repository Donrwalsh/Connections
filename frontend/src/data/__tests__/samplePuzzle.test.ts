import { describe, expect, it } from "vitest";
import type { Category } from "../samplePuzzle";
import { shuffleWords } from "../samplePuzzle";

const categories: Category[] = [
  {
    id: "cat-1",
    name: "A",
    difficulty: "yellow",
    words: ["ONE", "TWO"],
  },
  {
    id: "cat-2",
    name: "B",
    difficulty: "blue",
    words: ["THREE", "FOUR"],
  },
];

describe("shuffleWords", () => {
  it("flattens all category words into a single array", () => {
    const result = shuffleWords(categories);

    expect(result.sort()).toEqual(["FOUR", "ONE", "THREE", "TWO"]);
  });

  it("returns an empty array when categories is undefined", () => {
    expect(shuffleWords(undefined as unknown as Category[])).toEqual([]);
  });
});
