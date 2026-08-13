import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proposeGroup } from "./solver.js";
import {
  solveOutputSchema,
  type ProposedGroup,
  type SolveRequest,
} from "./types.js";

const WORDS = ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE", "FFFF", "GGGG", "HHHH"];

function makeRequest(overrides: Partial<SolveRequest> = {}): SolveRequest {
  return {
    puzzleWords: WORDS,
    priorGuesses: [],
    numResponses: 1,
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
        proposed_groups: [
          makeGroup(),
          makeGroup(),
          makeGroup(),
          makeGroup(),
          makeGroup(),
        ],
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
      (call) =>
        Math.round((call[0] as { temperature: number }).temperature * 10000) /
        10000,
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
    expect(result.proposals).toEqual([
      { ...makeGroup(), promptNumber: 1, status: "used" },
    ]);
    expect(result.prompt).toContain("Remaining words");
    expect(result.model).toBe("test-model");
    expect(result.contextWindow).toBe(4096);
    expect(result.temperature).toBe(0.2);
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

    // Per-prompt tracking record: one entry for the single call, without the
    // (large) prompt text.
    expect(result.promptMetadata).toHaveLength(1);
    expect(result.promptMetadata[0]).toMatchObject({
      attempt: 1,
      temperature: 0.2,
      numResponses: 1,
      model: "test-model",
      contextWindow: 4096,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      outcome: "accepted",
    });
    expect(typeof result.promptMetadata[0].latencyMs).toBe("number");
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

  it("defaults the temperature to 0.2 and always passes it to the model", async () => {
    await proposeGroup(makeRequest());

    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.2 }),
    );
  });

  it("starts retries at the parameters supplied by the caller", async () => {
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

  it("requests more candidates when every candidate repeats a prior guess", async () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
      ],
    });
    generateObjectMock
      .mockResolvedValueOnce(makeOutput([makeGroup(), makeGroup()]))
      .mockResolvedValueOnce(
        makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]),
      );

    const result = await proposeGroup(request);

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    // The temperature stays fixed across re-prompts.
    expect(lastTemperatures()).toEqual([0.2, 0.2]);
    // The first escalation asks for an extra distinct candidate.
    expect(schemaAcceptsCount(0, 1)).toBe(true);
    expect(schemaAcceptsCount(0, 2)).toBe(false);
    expect(schemaAcceptsCount(1, 2)).toBe(true);
    expect(schemaAcceptsCount(1, 3)).toBe(false);
    expect(result.proposedGroups).toEqual([
      makeGroup({ word_ids: [4, 5, 6, 7] }),
    ]);
    expect(result.proposals).toEqual([
      { ...makeGroup(), promptNumber: 1, status: "rejected_duplicate" },
      { ...makeGroup(), promptNumber: 1, status: "rejected_duplicate" },
      {
        ...makeGroup({ word_ids: [4, 5, 6, 7] }),
        promptNumber: 2,
        status: "used",
      },
    ]);
    expect(result.temperature).toBe(0.2);
    expect(result.numResponses).toBe(2);
    expect(result.promptAttempts).toBe(2);
    expect(result.duplicatesRejected).toBe(2);
  });

  it("records fresh groups passed over in favor of a higher-confidence proposal as not_selected", async () => {
    generateObjectMock.mockResolvedValueOnce(
      makeOutput([
        makeGroup(),
        makeGroup({ word_ids: [4, 5, 6, 7], confidence: 0.8 }),
        makeGroup({ word_ids: [0, 2, 4, 6], confidence: 0.7 }),
      ]),
    );

    const result = await proposeGroup(makeRequest({ numResponses: 3 }));

    expect(result.proposedGroups).toEqual([makeGroup()]);
    expect(result.proposals).toEqual([
      { ...makeGroup(), promptNumber: 1, status: "used" },
      {
        word_ids: [4, 5, 6, 7],
        category: "Test",
        confidence: 0.8,
        reasoning: "test",
        promptNumber: 1,
        status: "not_selected",
      },
      {
        word_ids: [0, 2, 4, 6],
        category: "Test",
        confidence: 0.7,
        reasoning: "test",
        promptNumber: 1,
        status: "not_selected",
      },
    ]);
  });

  it("requests one more candidate on each escalation", async () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
      ],
    });
    generateObjectMock
      .mockResolvedValueOnce(makeOutput([makeGroup()]))
      .mockResolvedValueOnce(makeOutput([makeGroup()]))
      .mockResolvedValueOnce(
        makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]),
      );

    const result = await proposeGroup(request);

    expect(generateObjectMock).toHaveBeenCalledTimes(3);
    // The temperature never moves during escalation.
    expect(lastTemperatures()).toEqual([0.2, 0.2, 0.2]);
    // Each escalation requests one more candidate.
    expect(schemaAcceptsCount(0, 1)).toBe(true);
    expect(schemaAcceptsCount(0, 2)).toBe(false);
    expect(schemaAcceptsCount(1, 2)).toBe(true);
    expect(schemaAcceptsCount(1, 3)).toBe(false);
    expect(schemaAcceptsCount(2, 3)).toBe(true);
    expect(schemaAcceptsCount(2, 4)).toBe(false);
    expect(result.temperature).toBe(0.2);
    expect(result.numResponses).toBe(3);
    expect(result.promptAttempts).toBe(3);
  });

  it("aggregates usage and latency across the re-prompts", async () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
      ],
    });
    generateObjectMock
      .mockResolvedValueOnce(makeOutput([makeGroup()]))
      .mockResolvedValueOnce(
        makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]),
      );

    const result = await proposeGroup(request);

    expect(result.promptAttempts).toBe(2);
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 40,
      totalTokens: 60,
    });
  });

  it("records one metadata entry per prompt with the escalation parameters and outcome", async () => {
    const request = makeRequest({
      priorGuesses: [
        { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
      ],
    });
    generateObjectMock
      .mockResolvedValueOnce(makeOutput([makeGroup()]))
      .mockResolvedValueOnce(
        makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]),
      );

    const result = await proposeGroup(request);

    expect(result.promptMetadata).toHaveLength(2);
    expect(result.promptMetadata[0]).toMatchObject({
      attempt: 1,
      numResponses: 1,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      outcome: "duplicate_rejected",
    });
    expect(result.promptMetadata[0].temperature).toBe(0.2);
    expect(result.promptMetadata[1]).toMatchObject({
      attempt: 2,
      numResponses: 2,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      outcome: "accepted",
    });
    expect(result.promptMetadata[1].temperature).toBe(0.2);
    // The metadata reflects the model that responded, even for the retry.
    expect(
      result.promptMetadata.every((entry) => entry.model === "test-model"),
    ).toBe(true);
  });

  it("records an invalid entry when the model emits malformed output and recovers", async () => {
    const { NoObjectGeneratedError } = await import("ai");
    const ctor = NoObjectGeneratedError as unknown as new (
      msg: string,
    ) => Error;
    generateObjectMock
      .mockRejectedValueOnce(new ctor("no object"))
      .mockResolvedValueOnce(
        makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]),
      );

    const result = await proposeGroup(makeRequest());

    expect(result.promptMetadata).toHaveLength(2);
    expect(result.promptMetadata[0]).toMatchObject({
      attempt: 1,
      outcome: "invalid",
    });
    // A failed call reports no usage, so the entry omits it.
    expect("usage" in result.promptMetadata[0]).toBe(false);
    expect(result.promptMetadata[1]).toMatchObject({
      attempt: 2,
      outcome: "accepted",
    });
  });

  it("carries per-prompt metadata on a duplicate budget-exhaustion failure", async () => {
    generateObjectMock.mockResolvedValue(makeOutput([makeGroup()]));

    await expect(
      proposeGroup(
        makeRequest({
          priorGuesses: [
            { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
          ],
          maxPrompts: 3,
        }),
      ),
    ).rejects.toMatchObject({
      code: "duplicate_group",
      details: {
        promptAttempts: 3,
        promptMetadata: [
          { attempt: 1, outcome: "duplicate_rejected" },
          { attempt: 2, outcome: "duplicate_rejected" },
          { attempt: 3, outcome: "duplicate_rejected" },
        ],
      },
    });
  });

  it("carries per-prompt metadata on a model error", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("boom"));

    let caught: unknown;
    try {
      await proposeGroup(makeRequest());
    } catch (err) {
      caught = err;
    }

    const details = (
      caught as {
        details?: {
          promptMetadata?: Array<{
            attempt: number;
            outcome: string;
            usage?: unknown;
          }>;
        };
      }
    ).details;
    expect((caught as { code?: string }).code).toBe("model_error");
    expect(details?.promptMetadata?.[0]).toMatchObject({
      attempt: 1,
      outcome: "error",
    });
    // The failed call reports no usage, so the entry omits it.
    expect("usage" in (details?.promptMetadata?.[0] ?? {})).toBe(false);
  });

  it("fails with duplicate_group after exhausting the prompt budget on repeats", async () => {
    generateObjectMock.mockResolvedValue(makeOutput([makeGroup()]));

    await expect(
      proposeGroup(
        makeRequest({
          priorGuesses: [
            { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
          ],
          maxPrompts: 3,
        }),
      ),
    ).rejects.toMatchObject({
      code: "duplicate_group",
      details: {
        promptAttempts: 3,
        duplicatesRejected: 3,
        proposedGroups: [makeGroup()],
        proposals: [
          { ...makeGroup(), promptNumber: 1, status: "rejected_duplicate" },
          { ...makeGroup(), promptNumber: 2, status: "rejected_duplicate" },
          { ...makeGroup(), promptNumber: 3, status: "rejected_duplicate" },
        ],
      },
    });
    expect(generateObjectMock).toHaveBeenCalledTimes(3);
    // The escalation ratchets the requested candidate count up before giving
    // up: one more candidate per re-prompt, at a fixed temperature.
    expect(lastTemperatures()).toEqual([0.2, 0.2, 0.2]);
    expect(schemaAcceptsCount(2, 3)).toBe(true);
    expect(schemaAcceptsCount(2, 4)).toBe(false);
  });

  it("fails with invalid_group when the model never produces well-formed output", async () => {
    const { NoObjectGeneratedError } = await import("ai");
    const ctor = NoObjectGeneratedError as unknown as new (
      msg: string,
    ) => Error;
    generateObjectMock.mockRejectedValue(new ctor("no object"));

    await expect(
      proposeGroup(makeRequest({ maxPrompts: 3 })),
    ).rejects.toMatchObject({
      code: "invalid_group",
      details: { promptAttempts: 3 },
    });
    expect(generateObjectMock).toHaveBeenCalledTimes(3);
  });

  it("re-prompts after a recoverable malformed output and succeeds on a later attempt", async () => {
    const { NoObjectGeneratedError } = await import("ai");
    const ctor = NoObjectGeneratedError as unknown as new (
      msg: string,
    ) => Error;
    generateObjectMock
      .mockRejectedValueOnce(new ctor("no object"))
      .mockResolvedValueOnce(
        makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]),
      );

    const result = await proposeGroup(makeRequest());

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(result.proposedGroups).toEqual([
      makeGroup({ word_ids: [4, 5, 6, 7] }),
    ]);
    expect(result.promptAttempts).toBe(2);
    expect(result.temperature).toBe(0.2);
  });

  it("keeps the temperature fixed across re-prompts for both providers", async () => {
    for (const modelProvider of ["openai", "ollama"] as const) {
      generateObjectMock.mockReset();
      generateObjectMock
        .mockResolvedValueOnce(makeOutput([makeGroup()]))
        .mockResolvedValueOnce(
          makeOutput([makeGroup({ word_ids: [4, 5, 6, 7] })]),
        );

      const request = makeRequest({
        modelProvider,
        priorGuesses: [
          { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
        ],
      });

      const result = await proposeGroup(request);

      expect(generateObjectMock).toHaveBeenCalledTimes(2);
      expect(lastTemperatures()).toEqual([0.2, 0.2]);
      expect(result.temperature).toBe(0.2);
    }
  });

  it("stops escalating when the candidate count is already at its cap", async () => {
    generateObjectMock.mockResolvedValue(makeOutput([makeGroup()]));

    await expect(
      proposeGroup(
        makeRequest({
          priorGuesses: [
            { words: ["AAAA", "BBBB", "CCCC", "DDDD"], result: "incorrect" },
          ],
          numResponses: 1,
          maxNumResponses: 1,
          maxPrompts: 5,
        }),
      ),
    ).rejects.toMatchObject({
      code: "duplicate_group",
      details: {
        promptAttempts: 1,
        numResponses: 1,
        temperature: 0.2,
      },
    });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
    // Nothing was left to escalate: no re-prompt happened.
    expect(lastTemperatures()).toEqual([0.2]);
  });

  it("does not re-prompt after an unrecoverable model error", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("boom"));

    await expect(proposeGroup(makeRequest())).rejects.toMatchObject({
      code: "model_error",
    });
    expect(generateObjectMock).toHaveBeenCalledTimes(1);
  });
});
