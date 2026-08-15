import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosePartition } from "./diagnose.js";
import { SolveError } from "./solver.js";

const WORDS = [
  "AAAA",
  "BBBB",
  "CCCC",
  "DDDD",
  "EEEE",
  "FFFF",
  "GGGG",
  "HHHH",
  "IIII",
  "JJJJ",
  "KKKK",
  "LLLL",
  "MMMM",
  "NNNN",
  "OOOO",
  "PPPP",
];

function makeGroups() {
  return [
    { category: "Test", items: WORDS.slice(0, 4), confidence: 0.9 },
    { category: "Test", items: WORDS.slice(4, 8), confidence: 0.9 },
    { category: "Test", items: WORDS.slice(8, 12), confidence: 0.9 },
    { category: "Test", items: WORDS.slice(12, 16), confidence: 0.9 },
  ];
}

describe("diagnosePartition", () => {
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
      object: { groups: makeGroups() },
      response: { modelId: "test-model" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the model's partition, the exact prompt, and the model name", async () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "4096");
    const result = await diagnosePartition(WORDS);

    expect(result.groups).toEqual(makeGroups());
    expect(result.prompt).toContain("Words: AAAA, BBBB");
    expect(result.prompt).toContain("Output ONLY the JSON object.");
    expect(result.model).toBe("test-model");
  });

  it("rejects a partition that reuses an item across groups", async () => {
    const groups = makeGroups();
    groups[1] = { ...groups[1], items: [groups[0].items[0], ...groups[1].items.slice(1)] };

    generateObjectMock.mockResolvedValueOnce({
      object: { groups },
      response: { modelId: "test-model" },
    });

    const result = diagnosePartition(WORDS);
    await expect(result).rejects.toBeInstanceOf(SolveError);
    await expect(result).rejects.toMatchObject({
      code: "invalid_group",
      message: 'Item "AAAA" appears in more than one group',
    });
  });

  it("rejects a partition that invents an item not on the board", async () => {
    const groups = makeGroups();
    groups[0] = { ...groups[0], items: ["AAAA", "BBBB", "CCCC", "NOTHING"] };

    generateObjectMock.mockResolvedValueOnce({
      object: { groups },
      response: { modelId: "test-model" },
    });

    const result = diagnosePartition(WORDS);
    await expect(result).rejects.toBeInstanceOf(SolveError);
    await expect(result).rejects.toMatchObject({
      code: "invalid_group",
      message: 'Item "NOTHING" is not on the board',
    });
  });

  it("accepts items echoed with altered case", async () => {
    const groups = makeGroups().map((group) => ({
      ...group,
      items: group.items.map((item) => item.toLowerCase()),
    }));

    generateObjectMock.mockResolvedValueOnce({
      object: { groups },
      response: { modelId: "test-model" },
    });

    const result = await diagnosePartition(WORDS);
    expect(result.groups).toEqual(groups);
  });

  it("classifies a provider failure as a model_error", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("openai is down"));

    await expect(diagnosePartition(WORDS)).rejects.toMatchObject({
      code: "model_error",
    });
  });

  it("classifies malformed output as an invalid_group", async () => {
    const { JSONParseError } = await import("ai");
    generateObjectMock.mockRejectedValueOnce(
      new (JSONParseError as unknown as { new (): Error })(),
    );

    await expect(diagnosePartition(WORDS)).rejects.toMatchObject({
      code: "invalid_group",
    });
  });
});
