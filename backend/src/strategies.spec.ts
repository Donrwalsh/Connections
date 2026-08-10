import {
  AUTOMATIC_STRATEGIES,
  DEFAULT_LLM_MAX_DUPLICATE_GUESSES,
  DEFAULT_LLM_MAX_MALFORMED_RESPONSES,
  DEFAULT_LLM_MAX_MODEL_ERRORS,
  DEFAULT_LLM_MAX_PROMPTS,
  DEFAULT_LLM_NUM_RESPONSES,
  DEFAULT_LLM_TEMPERATURE_BASE,
  DEFAULT_LLM_TEMPERATURE_MAX,
  DEFAULT_SHUFFLE_FOOLISH_DUPLICATE_LIMIT,
  DEFAULT_SHUFFLE_FOOLISH_TRIALS,
  DEFAULT_SHUFFLE_SMART_TRIALS,
  llmMaxDuplicateGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmMaxPrompts,
  llmNumResponses,
  llmTemperatureBase,
  llmTemperatureMax,
  llmTemperatureStep,
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

  describe("llmMaxModelErrors", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(llmMaxModelErrors({})).toBe(DEFAULT_LLM_MAX_MODEL_ERRORS);
      expect(llmMaxModelErrors({ LLM_MAX_MODEL_ERRORS: "0" })).toBe(DEFAULT_LLM_MAX_MODEL_ERRORS);
      expect(llmMaxModelErrors({ LLM_MAX_MODEL_ERRORS: "abc" })).toBe(DEFAULT_LLM_MAX_MODEL_ERRORS);
    });

    it("should read a valid positive integer", () => {
      expect(llmMaxModelErrors({ LLM_MAX_MODEL_ERRORS: "9" })).toBe(9);
    });
  });

  describe("llmNumResponses", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(llmNumResponses({})).toBe(DEFAULT_LLM_NUM_RESPONSES);
      expect(llmNumResponses({ LLM_NUM_RESPONSES: "abc" })).toBe(DEFAULT_LLM_NUM_RESPONSES);
      expect(llmNumResponses({ LLM_NUM_RESPONSES: "0" })).toBe(DEFAULT_LLM_NUM_RESPONSES);
    });

    it("should read a valid positive integer", () => {
      expect(llmNumResponses({ LLM_NUM_RESPONSES: "8" })).toBe(8);
    });

    it("should clamp to the configured maximum", () => {
      expect(llmNumResponses({ LLM_NUM_RESPONSES: "100" })).toBe(10);
    });
  });

  describe("llmMaxPrompts", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(llmMaxPrompts({})).toBe(DEFAULT_LLM_MAX_PROMPTS);
      expect(llmMaxPrompts({ LLM_MAX_PROMPTS: "abc" })).toBe(DEFAULT_LLM_MAX_PROMPTS);
      expect(llmMaxPrompts({ LLM_MAX_PROMPTS: "0" })).toBe(DEFAULT_LLM_MAX_PROMPTS);
    });

    it("should read a valid positive integer", () => {
      expect(llmMaxPrompts({ LLM_MAX_PROMPTS: "7" })).toBe(7);
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

  describe("llmTemperatureBase", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(llmTemperatureBase({})).toBe(DEFAULT_LLM_TEMPERATURE_BASE);
      expect(llmTemperatureBase({ LLM_TEMPERATURE_BASE: "-1" })).toBe(DEFAULT_LLM_TEMPERATURE_BASE);
    });

    it("should read a valid non-negative number", () => {
      expect(llmTemperatureBase({ LLM_TEMPERATURE_BASE: "0.7" })).toBe(0.7);
    });
  });

  describe("llmTemperatureMax", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(llmTemperatureMax({})).toBe(DEFAULT_LLM_TEMPERATURE_MAX);
      expect(llmTemperatureMax({ LLM_TEMPERATURE_MAX: "abc" })).toBe(DEFAULT_LLM_TEMPERATURE_MAX);
      expect(llmTemperatureMax({ LLM_TEMPERATURE_MAX: "0" })).toBe(DEFAULT_LLM_TEMPERATURE_MAX);
    });

    it("should read a valid positive number", () => {
      expect(llmTemperatureMax({ LLM_TEMPERATURE_MAX: "4.0" })).toBe(4.0);
    });
  });

  describe("llmTemperatureStep", () => {
    it("should derive the step from the default base and ceiling", () => {
      expect(llmTemperatureStep({})).toBeCloseTo(
        (DEFAULT_LLM_TEMPERATURE_MAX - DEFAULT_LLM_TEMPERATURE_BASE) / 100,
        10,
      );
    });

    it("should derive the step so 100 increments reach the configured ceiling", () => {
      expect(
        llmTemperatureStep({ LLM_TEMPERATURE_BASE: "0.5", LLM_TEMPERATURE_MAX: "3.0" }),
      ).toBeCloseTo(0.025, 10);
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
