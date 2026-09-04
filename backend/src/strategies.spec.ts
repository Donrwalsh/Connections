import {
  AUTOMATIC_STRATEGIES,
  DEFAULT_LLM_MAX_DUPLICATE_GUESSES,
  DEFAULT_LLM_MAX_FAILED_GUESSES,
  DEFAULT_LLM_MAX_MALFORMED_RESPONSES,
  DEFAULT_LLM_MAX_MODEL_ERRORS,
  DEFAULT_LLM_MAX_PROMPTS,
  DEFAULT_LLM_NUM_RESPONSES,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_TRIALS_PER_MODEL,
  DEFAULT_LLM_OPENAI_CONCURRENCY,
  DEFAULT_LLM_OLLAMA_CONCURRENCY,
  DEFAULT_LLM_GOOGLE_CONCURRENCY,
  DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS,
  DEFAULT_SHUFFLE_TRIALS,
  isLlmStrategy,
  LLM_OPENAI,
  LLM_OLLAMA,
  LLM_GOOGLE,
  LLM_STRATEGIES,
  llmMaxDuplicateGuesses,
  llmMaxFailedGuesses,
  llmMaxMalformedResponses,
  llmMaxModelErrors,
  llmMaxPrompts,
  llmNumResponses,
  llmOllamaConcurrency,
  llmOpenAIConcurrency,
  llmGoogleConcurrency,
  llmGoogleRateLimitFallbackSeconds,
  llmTemperature,
  llmMaxTrialsPerModel,
  nextDailyAutomationRunAt,
  shuffleTrialCount,
  strategyTrialNumbers,
  SUPPORTED_STRATEGIES,
  STRATEGY_SET,
  workerRole,
} from "./strategies";

describe("strategies", () => {
  describe("shuffleTrialCount", () => {
    it("should default when the env var is missing", () => {
      expect(shuffleTrialCount({})).toBe(DEFAULT_SHUFFLE_TRIALS);
    });

    it("should default when the env var is invalid", () => {
      expect(shuffleTrialCount({ SHUFFLE_TRIALS: "abc" })).toBe(DEFAULT_SHUFFLE_TRIALS);
      expect(shuffleTrialCount({ SHUFFLE_TRIALS: "0" })).toBe(DEFAULT_SHUFFLE_TRIALS);
      expect(shuffleTrialCount({ SHUFFLE_TRIALS: "-2" })).toBe(DEFAULT_SHUFFLE_TRIALS);
    });

    it("should read a valid positive integer", () => {
      expect(shuffleTrialCount({ SHUFFLE_TRIALS: "7" })).toBe(7);
    });
  });

  describe("llmMaxTrialsPerModel", () => {
    it("should default when the env var is missing", () => {
      expect(llmMaxTrialsPerModel({})).toBe(DEFAULT_LLM_TRIALS_PER_MODEL);
    });

    it("should default when the env var is invalid", () => {
      expect(llmMaxTrialsPerModel({ LLM_TRIALS_PER_MODEL: "abc" })).toBe(
        DEFAULT_LLM_TRIALS_PER_MODEL,
      );
      expect(llmMaxTrialsPerModel({ LLM_TRIALS_PER_MODEL: "0" })).toBe(
        DEFAULT_LLM_TRIALS_PER_MODEL,
      );
      expect(llmMaxTrialsPerModel({ LLM_TRIALS_PER_MODEL: "-2" })).toBe(
        DEFAULT_LLM_TRIALS_PER_MODEL,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmMaxTrialsPerModel({ LLM_TRIALS_PER_MODEL: "5" })).toBe(5);
    });
  });

  describe("llmOpenAIConcurrency", () => {
    it("should default when the env var is missing", () => {
      expect(llmOpenAIConcurrency({})).toBe(DEFAULT_LLM_OPENAI_CONCURRENCY);
    });

    it("should default when the env var is invalid", () => {
      expect(llmOpenAIConcurrency({ LLM_OPENAI_CONCURRENCY: "abc" })).toBe(
        DEFAULT_LLM_OPENAI_CONCURRENCY,
      );
      expect(llmOpenAIConcurrency({ LLM_OPENAI_CONCURRENCY: "0" })).toBe(
        DEFAULT_LLM_OPENAI_CONCURRENCY,
      );
      expect(llmOpenAIConcurrency({ LLM_OPENAI_CONCURRENCY: "-1" })).toBe(
        DEFAULT_LLM_OPENAI_CONCURRENCY,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmOpenAIConcurrency({ LLM_OPENAI_CONCURRENCY: "3" })).toBe(3);
    });
  });

  describe("llmOllamaConcurrency", () => {
    it("should default when the env var is missing", () => {
      expect(llmOllamaConcurrency({})).toBe(DEFAULT_LLM_OLLAMA_CONCURRENCY);
    });

    it("should default when the env var is invalid", () => {
      expect(llmOllamaConcurrency({ LLM_OLLAMA_CONCURRENCY: "abc" })).toBe(
        DEFAULT_LLM_OLLAMA_CONCURRENCY,
      );
      expect(llmOllamaConcurrency({ LLM_OLLAMA_CONCURRENCY: "0" })).toBe(
        DEFAULT_LLM_OLLAMA_CONCURRENCY,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmOllamaConcurrency({ LLM_OLLAMA_CONCURRENCY: "2" })).toBe(2);
    });
  });

  describe("llmGoogleConcurrency", () => {
    it("should default when the env var is missing", () => {
      expect(llmGoogleConcurrency({})).toBe(DEFAULT_LLM_GOOGLE_CONCURRENCY);
    });

    it("should default when the env var is invalid", () => {
      expect(llmGoogleConcurrency({ LLM_GOOGLE_CONCURRENCY: "abc" })).toBe(
        DEFAULT_LLM_GOOGLE_CONCURRENCY,
      );
      expect(llmGoogleConcurrency({ LLM_GOOGLE_CONCURRENCY: "0" })).toBe(
        DEFAULT_LLM_GOOGLE_CONCURRENCY,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmGoogleConcurrency({ LLM_GOOGLE_CONCURRENCY: "4" })).toBe(4);
    });
  });

  describe("llmGoogleRateLimitFallbackSeconds", () => {
    it("should default when the env var is missing", () => {
      expect(llmGoogleRateLimitFallbackSeconds({})).toBe(DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS);
    });

    it("should default when the env var is invalid", () => {
      expect(llmGoogleRateLimitFallbackSeconds({ LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS: "abc" })).toBe(
        DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS,
      );
      expect(llmGoogleRateLimitFallbackSeconds({ LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS: "0" })).toBe(
        DEFAULT_LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmGoogleRateLimitFallbackSeconds({ LLM_GOOGLE_RATE_LIMIT_FALLBACK_SECONDS: "90" })).toBe(90);
    });
  });

  describe("workerRole", () => {
    it("should default to 'all' when the env var is missing or invalid", () => {
      expect(workerRole({})).toBe("all");
      expect(workerRole({ WORKER_ROLE: "bogus" })).toBe("all");
    });

    it("should read 'cloud' and 'ollama', case-insensitively", () => {
      expect(workerRole({ WORKER_ROLE: "cloud" })).toBe("cloud");
      expect(workerRole({ WORKER_ROLE: "OLLAMA" })).toBe("ollama");
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

  describe("llmMaxFailedGuesses", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(llmMaxFailedGuesses({})).toBe(DEFAULT_LLM_MAX_FAILED_GUESSES);
      expect(llmMaxFailedGuesses({ LLM_MAX_FAILED_GUESSES: "0" })).toBe(
        DEFAULT_LLM_MAX_FAILED_GUESSES,
      );
      expect(llmMaxFailedGuesses({ LLM_MAX_FAILED_GUESSES: "abc" })).toBe(
        DEFAULT_LLM_MAX_FAILED_GUESSES,
      );
    });

    it("should read a valid positive integer", () => {
      expect(llmMaxFailedGuesses({ LLM_MAX_FAILED_GUESSES: "2" })).toBe(2);
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

  describe("llmTemperature", () => {
    it("should default when the env var is missing or invalid", () => {
      expect(llmTemperature({})).toBe(DEFAULT_LLM_TEMPERATURE);
      expect(llmTemperature({ LLM_TEMPERATURE_BASE: "-1" })).toBe(DEFAULT_LLM_TEMPERATURE);
      expect(llmTemperature({ LLM_TEMPERATURE_BASE: "abc" })).toBe(DEFAULT_LLM_TEMPERATURE);
    });

    it("should read a valid non-negative number", () => {
      expect(llmTemperature({ LLM_TEMPERATURE_BASE: "0.7" })).toBe(0.7);
    });
  });

  describe("strategyTrialNumbers", () => {
    it("should return a single trial 0 for deterministic strategies", () => {
      for (const strategyName of SUPPORTED_STRATEGIES.filter(
        (s) => s !== "shuffle-smart" && s !== "shuffle-foolish" && !isLlmStrategy(s),
      )) {
        expect(strategyTrialNumbers(strategyName)).toEqual([0]);
      }
    });

    it("should return 1..N for each shuffle strategy, sharing the one SHUFFLE_TRIALS value", () => {
      for (const strategyName of ["shuffle-smart", "shuffle-foolish"]) {
        expect(strategyTrialNumbers(strategyName, { SHUFFLE_TRIALS: "2" })).toEqual([1, 2]);
        expect(strategyTrialNumbers(strategyName, {})).toEqual([1, 2, 3]);
      }
    });

    it("should return 1..N for each LLM strategy", () => {
      for (const strategyName of LLM_STRATEGIES) {
        expect(strategyTrialNumbers(strategyName, { LLM_TRIALS_PER_MODEL: "2" })).toEqual([1, 2]);
        expect(strategyTrialNumbers(strategyName, {})).toEqual([1, 2, 3]);
      }
    });
  });

  it("should keep STRATEGY_SET in sync with SUPPORTED_STRATEGIES", () => {
    for (const strategyName of SUPPORTED_STRATEGIES) {
      expect(STRATEGY_SET.has(strategyName)).toBe(true);
    }
  });

  describe("isLlmStrategy", () => {
    it("should identify all three LLM strategies", () => {
      expect(isLlmStrategy(LLM_OPENAI)).toBe(true);
      expect(isLlmStrategy(LLM_OLLAMA)).toBe(true);
      expect(isLlmStrategy(LLM_GOOGLE)).toBe(true);
    });

    it("should reject non-LLM strategies", () => {
      expect(isLlmStrategy("alphabetical")).toBe(false);
      expect(isLlmStrategy("llm")).toBe(false);
    });
  });

  describe("AUTOMATIC_STRATEGIES", () => {
    it("should be a subset of SUPPORTED_STRATEGIES", () => {
      for (const strategyName of AUTOMATIC_STRATEGIES) {
        expect(SUPPORTED_STRATEGIES).toContain(strategyName);
      }
    });

    it("should exclude the LLM strategies until they are evaluated", () => {
      for (const strategyName of LLM_STRATEGIES) {
        expect(AUTOMATIC_STRATEGIES).not.toContain(strategyName);
      }
    });

    it("should include every non-LLM strategy", () => {
      const expected = SUPPORTED_STRATEGIES.filter((s) => !isLlmStrategy(s));
      expect([...AUTOMATIC_STRATEGIES].sort()).toEqual([...expected].sort());
    });
  });

  describe("nextDailyAutomationRunAt", () => {
    it("returns today's 00:15 UTC when called before that time", () => {
      const now = new Date("2024-06-01T00:00:00.000Z");
      expect(nextDailyAutomationRunAt(now).toISOString()).toBe("2024-06-01T00:15:00.000Z");
    });

    it("returns tomorrow's 00:15 UTC when called after that time", () => {
      const now = new Date("2024-06-01T12:00:00.000Z");
      expect(nextDailyAutomationRunAt(now).toISOString()).toBe("2024-06-02T00:15:00.000Z");
    });

    it("returns tomorrow's 00:15 UTC when called exactly at that time", () => {
      const now = new Date("2024-06-01T00:15:00.000Z");
      expect(nextDailyAutomationRunAt(now).toISOString()).toBe("2024-06-02T00:15:00.000Z");
    });
  });
});
