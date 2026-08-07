import {
  AUTOMATIC_STRATEGIES,
  DEFAULT_LLM_MAX_DUPLICATE_GUESSES,
  DEFAULT_LLM_MAX_MALFORMED_RESPONSES,
  DEFAULT_SHUFFLE_FOOLISH_DUPLICATE_LIMIT,
  DEFAULT_SHUFFLE_FOOLISH_TRIALS,
  DEFAULT_SHUFFLE_SMART_TRIALS,
  llmMaxDuplicateGuesses,
  llmMaxMalformedResponses,
  shuffleFoolishDuplicateLimit,
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
      expect(shuffleFoolishTrialCount({ SHUFFLE_FOOLISH_TRIALS: "4" })).toBe(4);
    });
  });

  describe("llmMaxDuplicateGuesses", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(llmMaxDuplicateGuesses({})).toBe(DEFAULT_LLM_MAX_DUPLICATE_GUESSES);
      expect(llmMaxDuplicateGuesses({ LLM_MAX_DUPLICATE_GUESSES: "abc" })).toBe(
        DEFAULT_LLM_MAX_DUPLICATE_GUESSES,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmMaxDuplicateGuesses({ LLM_MAX_DUPLICATE_GUESSES: "5" })).toBe(5);
    });
  });

  describe("llmMaxMalformedResponses", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(llmMaxMalformedResponses({})).toBe(DEFAULT_LLM_MAX_MALFORMED_RESPONSES);
      expect(llmMaxMalformedResponses({ LLM_MAX_MALFORMED_RESPONSES: "0" })).toBe(
        DEFAULT_LLM_MAX_MALFORMED_RESPONSES,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmMaxMalformedResponses({ LLM_MAX_MALFORMED_RESPONSES: "7" })).toBe(7);
    });
  });

  describe("shuffleFoolishDuplicateLimit", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(shuffleFoolishDuplicateLimit({})).toBe(DEFAULT_SHUFFLE_FOOLISH_DUPLICATE_LIMIT);
      expect(shuffleFoolishDuplicateLimit({ SHUFFLE_FOOLISH_DUPLICATE_LIMIT: "-1" })).toBe(
        DEFAULT_SHUFFLE_FOOLISH_DUPLICATE_LIMIT,
      );
    });

    it("should read a valid positive integer", () => {
      expect(shuffleFoolishDuplicateLimit({ SHUFFLE_FOOLISH_DUPLICATE_LIMIT: "4" })).toBe(4);
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
      expect(strategyTrialNumbers("shuffle-smart", { SHUFFLE_SMART_TRIALS: "3" })).toEqual([
        1, 2, 3,
      ]);
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

  describe("AUTOMATIC_STRATEGIES", () => {
    it("should be a subset of SUPPORTED_STRATEGIES", () => {
      for (const strategyName of AUTOMATIC_STRATEGIES) {
        expect(SUPPORTED_STRATEGIES).toContain(strategyName);
      }
    });

    it("should exclude 'llm' until it is evaluated", () => {
      expect(AUTOMATIC_STRATEGIES).not.toContain("llm");
    });

    it("should include every non-llm strategy", () => {
      const expected = SUPPORTED_STRATEGIES.filter((s) => s !== "llm");
      expect([...AUTOMATIC_STRATEGIES].sort()).toEqual([...expected].sort());
    });
  });
});
