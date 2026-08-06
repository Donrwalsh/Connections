import { combinationToWords, firstCombination, nextCombination } from "./combinatorics";

describe("combinatorics", () => {
  describe("nextCombination", () => {
    it("should generate the full sequence for poolSize=5, k=4 then null", () => {
      const expected = [
        [0, 1, 2, 3],
        [0, 1, 2, 4],
        [0, 1, 3, 4],
        [0, 2, 3, 4],
        [1, 2, 3, 4],
      ];

      let combo: number[] | null = firstCombination(4);
      const seen: (number[] | null)[] = [];
      while (combo) {
        seen.push(combo);
        combo = nextCombination(combo, 5);
      }
      seen.push(null);

      expect(seen).toEqual([...expected, null]);
    });

    it("should increment the trailing index when it can still grow", () => {
      expect(nextCombination([0, 1, 2], 4)).toEqual([0, 1, 3]);
      expect(nextCombination([0, 2, 3], 5)).toEqual([0, 2, 4]);
      expect(nextCombination([1, 2], 4)).toEqual([1, 3]);
    });

    it("should carry the increment and re-suffix following indices", () => {
      expect(nextCombination([0, 3, 4], 6)).toEqual([0, 3, 5]);
      expect(nextCombination([0, 4, 5], 6)).toEqual([1, 2, 3]);
      expect(nextCombination([2, 3, 4], 6)).toEqual([2, 3, 5]);
    });

    it("should return null when the last combination is reached", () => {
      expect(nextCombination([2, 3, 4], 5)).toBeNull();
      expect(nextCombination([1, 2, 3, 4], 5)).toBeNull();
      expect(nextCombination([0], 1)).toBeNull();
    });

    it("should handle k=1", () => {
      expect(nextCombination([0], 3)).toEqual([1]);
      expect(nextCombination([1], 3)).toEqual([2]);
      expect(nextCombination([2], 3)).toBeNull();
    });

    it("should not mutate the input array", () => {
      const input = [0, 1, 2];
      nextCombination(input, 5);
      expect(input).toEqual([0, 1, 2]);
    });
  });

  describe("combinationToWords", () => {
    const pool = ["APPLE", "BANANA", "CHERRY", "DATE", "FIG"];

    it("should map indices to the corresponding pool entries", () => {
      expect(combinationToWords([0, 1, 2, 3], pool)).toEqual(["APPLE", "BANANA", "CHERRY", "DATE"]);
      expect(combinationToWords([1, 4], pool)).toEqual(["BANANA", "FIG"]);
    });

    it("should return an empty list for an empty index list", () => {
      expect(combinationToWords([], pool)).toEqual([]);
    });
  });

  describe("firstCombination", () => {
    it("should build the lowest k indices", () => {
      expect(firstCombination(4)).toEqual([0, 1, 2, 3]);
      expect(firstCombination(1)).toEqual([0]);
      expect(firstCombination(0)).toEqual([]);
    });
  });
});
