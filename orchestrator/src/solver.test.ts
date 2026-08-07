import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeGroup } from "./solver.js";
import { solveOutputSchema, type ProposedGroup, type SolveRequest } from "./types.js";

const WORDS = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"];

function makeRequest(overrides: Partial<SolveRequest> = {}): SolveRequest {
  return { puzzleWords: WORDS, priorGuesses: [], numResponses: 5, ...overrides };
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

function makeOutput(count = 5) {
  return {
    object: {
      proposed_groups: Array.from({ length: count }, () => makeGroup()),
    },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    response: { modelId: "test-model" },
  };
}

describe("solveOutputSchema", () => {
  it("accepts exactly the requested number of candidate groups", () => {
    const schema = solveOutputSchema(5);

    expect(
      schema.safeParse({
        proposed_groups: [makeGroup(), makeGroup(), makeGroup(), makeGroup(), makeGroup()],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        proposed_groups: [makeGroup(), makeGroup(), makeGroup(), makeGroup()],
      }).success,
    ).toBe(false);
    expect(schema.safeParse({ proposed_groups: [] }).success).toBe(false);
  });

  it("rejects a candidate that is not four word IDs", () => {
    const schema = solveOutputSchema(1);

    expect(
      schema.safeParse({
        proposed_groups: [{ ...makeGroup(), word_ids: [0, 1, 2] }],
      }).success,
    ).toBe(false);
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
    generateObjectMock.mockResolvedValue(makeOutput());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the candidate groups plus prompt, model and usage metadata", async () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "4096");
    const result = await proposeGroup(makeRequest());

    expect(result.proposedGroups).toHaveLength(5);
    expect(result.proposedGroups[0]).toEqual(makeGroup());
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

  it("asks the model for exactly the requested number of groups", async () => {
    await proposeGroup(makeRequest({ numResponses: 3 }));

    const call = generateObjectMock.mock.calls[0][0] as {
      schema: { safeParse: (value: unknown) => { success: boolean } };
    };
    expect(
      call.schema.safeParse({
        proposed_groups: [makeGroup(), makeGroup(), makeGroup()],
      }).success,
    ).toBe(true);
    expect(
      call.schema.safeParse({
        proposed_groups: [makeGroup(), makeGroup(), makeGroup(), makeGroup()],
      }).success,
    ).toBe(false);
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

  it("forwards the requested temperature to the model and reflects it in the result", async () => {
    const result = await proposeGroup(makeRequest({ temperature: 1.3 }));

    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 1.3 }),
    );
    expect(result.temperature).toBe(1.3);
  });

  it("omits temperature when the request does not provide one", async () => {
    await proposeGroup(makeRequest());

    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ temperature: expect.any(Number) }),
    );
  });

  it("passes previously-guessed groups through for the backend to resolve", async () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
      ],
    });

    const result = await proposeGroup(request);

    // Duplicate-vs-fresh selection is the backend's job; the orchestrator
    // just returns every candidate the model produced.
    expect(result.proposedGroups[0].word_ids).toEqual([0, 1, 2, 3]);
  });
});
