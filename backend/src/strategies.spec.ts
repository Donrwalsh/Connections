import {
  DEFAULT_SHUFFLE_FOOLISH_TRIALS,
  DEFAULT_SHUFFLE_SMART_TRIALS,
  shuffleFoolishTrialCount,
  shuffleSmartTrialCount,
  strategyTrialNumbers,
  SUPPORTED_STRATEGIES,
  STRATEGY_SET,
} from "./strategies";

describe("strategies", () => {
  describe("shuffleSmartTrialCount", () => {
    it("should default when the env var is missing", () => {
      expect(shuffleSmartTrialCount({})).toBe(DEFAULT_SHUFFLE_SMART_TRIALS);
    });

    it("should default when the env var is invalid", () => {
      expect(shuffleSmartTrialCount({ SHUFFLE_SMART_TRIALS: "abc" })).toBe(
        DEFAULT_SHUFFLE_SMART_TRIALS,
      );
      expect(shuffleSmartTrialCount({ SHUFFLE_SMART_TRIALS: "0" })).toBe(
        DEFAULT_SHUFFLE_SMART_TRIALS,
      );
      expect(shuffleSmartTrialCount({ SHUFFLE_SMART_TRIALS: "-2" })).toBe(
        DEFAULT_SHUFFLE_SMART_TRIALS,
      );
    });

    it("should read a valid positive integer", () => {
      expect(shuffleSmartTrialCount({ SHUFFLE_SMART_TRIALS: "7" })).toBe(7);
    });
  });

  describe("shuffleFoolishTrialCount", () => {
    it("should default when the env var is missing", () => {
      expect(shuffleFoolishTrialCount({})).toBe(DEFAULT_SHUFFLE_FOOLISH_TRIALS);
    });

    it("should default when the env var is invalid", () => {
      expect(shuffleFoolishTrialCount({ SHUFFLE_FOOLISH_TRIALS: "abc" })).toBe(
        DEFAULT_SHUFFLE_FOOLISH_TRIALS,
      );
    });

    it("should read a valid positive integer", () => {
      expect(
        shuffleFoolishTrialCount({ SHUFFLE_FOOLISH_TRIALS: "4" }),
      ).toBe(4);
    });
  });

  describe("strategyTrialNumbers", () => {
    it("should return a single trial 0 for deterministic strategies", () => {
      for (const strategyName of SUPPORTED_STRATEGIES.filter(
        (s) => s !== "shuffle-smart" && s !== "shuffle-foolish",
      )) {
        expect(strategyTrialNumbers(strategyName)).toEqual([0]);
      }
    });

    it("should return 1..N for shuffle-smart", () => {
      expect(
        strategyTrialNumbers("shuffle-smart", { SHUFFLE_SMART_TRIALS: "3" }),
      ).toEqual([1, 2, 3]);
      expect(strategyTrialNumbers("shuffle-smart", {})).toEqual([1, 2, 3]);
    });

    it("should return 1..N for shuffle-foolish", () => {
      expect(
        strategyTrialNumbers("shuffle-foolish", {
          SHUFFLE_FOOLISH_TRIALS: "2",
        }),
      ).toEqual([1, 2]);
      expect(strategyTrialNumbers("shuffle-foolish", {})).toEqual([1, 2, 3]);
    });
  });

  it("should keep STRATEGY_SET in sync with SUPPORTED_STRATEGIES", () => {
    for (const strategyName of SUPPORTED_STRATEGIES) {
      expect(STRATEGY_SET.has(strategyName)).toBe(true);
    }
  });
});
