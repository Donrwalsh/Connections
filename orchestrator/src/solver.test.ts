import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateProposedGroup, proposeGroup, SolveError } from "./solver.js";
import type { ProposedGroup, SolveRequest } from "./types.js";

const WORDS = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"];

function makeRequest(overrides: Partial<SolveRequest> = {}): SolveRequest {
  return { puzzleWords: WORDS, priorGuesses: [], ...overrides };
}

function makeGroup(overrides: Partial<ProposedGroup> = {}): ProposedGroup {
  return {
    word_ids: [0, 1, 2, 3],
    category: "Test",
    confidence: 0.9,
    reasoning: "test",
    ...overrides,
  };
}

describe("validateProposedGroup", () => {
  it("accepts a valid, unique group of in-range IDs", () => {
    expect(() =>
      validateProposedGroup(makeGroup(), makeRequest()),
    ).not.toThrow();
  });

  it("rejects IDs outside the remaining word list as invalid_group", () => {
    try {
      validateProposedGroup(
        makeGroup({ word_ids: [0, 1, 2, 99] }),
        makeRequest(),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SolveError);
      expect((err as SolveError).code).toBe("invalid_group");
      expect((err as SolveError).message).toMatch(
        /not present in the puzzle's remaining word list/,
      );
    }
  });

  it("rejects duplicate IDs as invalid_group", () => {
    try {
      validateProposedGroup(
        makeGroup({ word_ids: [0, 1, 1, 2] }),
        makeRequest(),
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SolveError);
      expect((err as SolveError).code).toBe("invalid_group");
      expect((err as SolveError).message).toMatch(/duplicate word IDs/);
    }
  });

  it("rejects a group that was already guessed as duplicate_group", () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
      ],
    });

    // Same four words, different order, must still be caught as a repeat.
    try {
      validateProposedGroup(makeGroup({ word_ids: [3, 2, 1, 0] }), request);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SolveError);
      expect((err as SolveError).code).toBe("duplicate_group");
      expect((err as SolveError).message).toMatch(/previously-guessed group/);
    }
  });

  it("does not treat a resolved (correct) guess as forbidden", () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "correct" },
      ],
    });

    expect(() =>
      validateProposedGroup(makeGroup(), request),
    ).not.toThrow();
  });
});

describe("proposeGroup", () => {
  const generateObjectMock = vi.hoisted(() => vi.fn());

  vi.mock("ai", () => ({
    generateObject: generateObjectMock,
    NoObjectGeneratedError: class NoObjectGeneratedError extends Error {},
    TypeValidationError: class TypeValidationError extends Error {},
    JSONParseError: class JSONParseError extends Error {},
  }));

  beforeEach(() => {
    generateObjectMock.mockReset();
    generateObjectMock.mockResolvedValue({
      object: makeGroup(),
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      response: { modelId: "test-model" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the group plus prompt, model and usage metadata", async () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "4096");
    const result = await proposeGroup(makeRequest());

    expect(result.proposedGroup).toEqual(makeGroup());
    expect(result.prompt).toContain("Remaining words");
    expect(result.model).toBe("test-model");
    expect(result.contextWindow).toBe(4096);
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
    expect(typeof result.latencyMs).toBe("number");
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });

  it("classifies malformed model output as invalid_group", async () => {
    generateObjectMock.mockRejectedValueOnce(
      new (class extends Error {})("boom"),
    );
    // NoObjectGeneratedError instance:
    const { NoObjectGeneratedError } = await import("ai");
    const ctor = NoObjectGeneratedError as unknown as new (msg: string) => Error;
    generateObjectMock.mockRejectedValueOnce(new ctor("no object"));

    await expect(proposeGroup(makeRequest())).rejects.toMatchObject({
      code: "model_error",
    });
    await expect(proposeGroup(makeRequest())).rejects.toMatchObject({
      code: "invalid_group",
    });
  });

  it("attaches proposed group + metadata to a duplicate_group failure", async () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
      ],
    });
    generateObjectMock.mockResolvedValueOnce({
      object: makeGroup({ word_ids: [3, 2, 1, 0] }),
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      response: { modelId: "test-model" },
    });

    const promise = proposeGroup(request);
    await expect(promise).rejects.toBeInstanceOf(SolveError);
    const err = await promise.catch((e) => e);
    expect(err.code).toBe("duplicate_group");
    expect(err.details.proposedGroup?.word_ids).toEqual([3, 2, 1, 0]);
    expect(err.details.model).toBe("test-model");
    expect(err.details.usage?.totalTokens).toBe(3);
  });
});
