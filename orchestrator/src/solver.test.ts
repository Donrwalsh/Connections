import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeGroup } from "./solver.js";
import { solveOutputSchema, type ProposedGroup, type SolveRequest } from "./types.js";

const WORDS = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"];

function makeRequest(overrides: Partial<SolveRequest> = {}): SolveRequest {
  return {
    puzzleWords: WORDS,
    priorGuesses: [],
    numResponses: 1,
    temperatureStep: 0.1,
    maxTemperature: 2,
    maxNumResponses: 10,
    maxPrompts: 5,
    ...overrides,
  } as SolveRequest;
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

function makeOutput(groups: ProposedGroup[] = [makeGroup()]) {
  return {
    object: { proposed_groups: groups },
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

  function lastTemperatures() {
    return generateObjectMock.mock.calls.map(
      (call) => (call[0] as { temperature: number }).temperature,
    );
  }

  function schemaAcceptsCount(callIndex: number, count: number): boolean {
    const call = generateObjectMock.mock.calls[callIndex][0] as {
      schema: { safeParse: (value: unknown) => { success: boolean } };
    };
    return call.schema.safeParse({
      proposed_groups: Array.from({ length: count }, () => makeGroup()),
    }).success;
  }

  it("returns the winning candidate plus prompt, model, usage and retry metadata", async () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "4096");
    const result = await proposeGroup(makeRequest());

    expect(result.proposedGroups).toEqual([makeGroup()]);
    expect(result.prompt).toContain("Remaining words");
    expect(result.model).toBe("test-model");
    expect(result.contextWindow).toBe(4096);
    expect(result.temperature).toBe(1);
    expect(result.numResponses).toBe(1);
    expect(result.promptAttempts).toBe(1);
    expect(result.duplicatesRejected).toBe(0);
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

  it("defaults the temperature to 1 and always passes it to the model", async () => {
    await proposeGroup(makeRequest());

    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 1 }),
    );
  });

  it("starts retries at the sticky parameters supplied by the caller", async () => {
    const result = await proposeGroup(
      makeRequest({ temperature: 1.3, numResponses: 3 }),
    );

    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 1.3 }),
    );
    expect(schemaAcceptsCount(0, 3)).toBe(true);
    expect(schemaAcceptsCount(0, 4)).toBe(false);
    expect(result.temperature).toBe(1.3);
    expect(result.numResponses).toBe(3);
  });

  it("re-prompts with a higher temperature when every candidate repeats a prior guess", async () => {
    const request = makeRequest({
      priorGuesses: [{ words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" }],
    });
    generateObjectMock
      .mockResolvedValueOnce(makeOutput([makeGroup(), makeGroup()]))
      .mockResolvedValueOnce(makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]));

    const result = await proposeGroup(request);

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(lastTemperatures()).toEqual([1, 1.1]);
    // The candidate count stays put on the temperature-raising re-prompt.
    expect(schemaAcceptsCount(0, 1)).toBe(true);
    expect(schemaAcceptsCount(0, 2)).toBe(false);
    expect(schemaAcceptsCount(1, 1)).toBe(true);
    expect(result.proposedGroups).toEqual([makeGroup({ word_ids: [4, 5, 6, 7] })]);
    expect(result.temperature).toBe(1.1);
    expect(result.numResponses).toBe(1);
    expect(result.promptAttempts).toBe(2);
    expect(result.duplicatesRejected).toBe(2);
  });

  it("alternates escalation by requesting more distinct candidates next", async () => {
    const request = makeRequest({
      priorGuesses: [{ words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" }],
    });
    generateObjectMock
      .mockResolvedValueOnce(makeOutput([makeGroup()]))
      .mockResolvedValueOnce(makeOutput([makeGroup()]))
      .mockResolvedValueOnce(makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]));

    const result = await proposeGroup(request);

    expect(generateObjectMock).toHaveBeenCalledTimes(3);
    expect(lastTemperatures()).toEqual([1, 1.1, 1.1]);
    // First re-prompt raises temperature; second re-prompt asks for a second
    // distinct candidate while keeping the raised temperature.
    expect(schemaAcceptsCount(0, 1)).toBe(true);
    expect(schemaAcceptsCount(0, 2)).toBe(false);
    expect(schemaAcceptsCount(1, 1)).toBe(true);
    expect(schemaAcceptsCount(2, 2)).toBe(true);
    expect(schemaAcceptsCount(2, 3)).toBe(false);
    expect(result.temperature).toBe(1.1);
    expect(result.numResponses).toBe(2);
    expect(result.promptAttempts).toBe(3);
  });

  it("aggregates usage and latency across the re-prompts", async () => {
    const request = makeRequest({
      priorGuesses: [{ words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" }],
    });
    generateObjectMock
      .mockResolvedValueOnce(makeOutput([makeGroup()]))
      .mockResolvedValueOnce(makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]));

    const result = await proposeGroup(request);

    expect(result.promptAttempts).toBe(2);
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 40,
      totalTokens: 60,
    });
  });

  it("fails with duplicate_group after exhausting the prompt budget on repeats", async () => {
    generateObjectMock.mockResolvedValue(makeOutput([makeGroup()]));

    await expect(
      proposeGroup(
        makeRequest({
          priorGuesses: [{ words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" }],
          maxPrompts: 3,
        }),
      ),
    ).rejects.toMatchObject({
      code: "duplicate_group",
      details: {
        promptAttempts: 3,
        duplicatesRejected: 3,
        proposedGroups: [makeGroup()],
      },
    });
    expect(generateObjectMock).toHaveBeenCalledTimes(3);
    // The escalations ratchet up before giving up: temp on the first re-prompt,
    // more responses on the second.
    expect(lastTemperatures()).toEqual([1, 1.1, 1.1]);
    expect(schemaAcceptsCount(2, 2)).toBe(true);
    expect(schemaAcceptsCount(2, 3)).toBe(false);
  });

  it("fails with invalid_group when the model never produces well-formed output", async () => {
    const { NoObjectGeneratedError } = await import("ai");
    const ctor = NoObjectGeneratedError as unknown as new (msg: string) => Error;
    generateObjectMock.mockRejectedValue(new ctor("no object"));

    await expect(proposeGroup(makeRequest({ maxPrompts: 3 }))).rejects.toMatchObject({
      code: "invalid_group",
      details: { promptAttempts: 3 },
    });
    expect(generateObjectMock).toHaveBeenCalledTimes(3);
  });

  it("re-prompts after a recoverable malformed output and succeeds on a later attempt", async () => {
    const { NoObjectGeneratedError } = await import("ai");
    const ctor = NoObjectGeneratedError as unknown as new (msg: string) => Error;
    generateObjectMock
      .mockRejectedValueOnce(new ctor("no object"))
      .mockResolvedValueOnce(makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]));

    const result = await proposeGroup(makeRequest());

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(result.proposedGroups).toEqual([makeGroup({ word_ids: [4, 5, 6, 7] })]);
    expect(result.promptAttempts).toBe(2);
    expect(result.temperature).toBe(1.1);
  });

  it("does not re-prompt after an unrecoverable model error", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("boom"));

    await expect(proposeGroup(makeRequest())).rejects.toMatchObject({
      code: "model_error",
    });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });
});
