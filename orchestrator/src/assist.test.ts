import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseAnswerGroups, runAssistStep } from "./assist.js";
import { SolveError } from "./solver.js";

const MESSAGES = [
  { role: "user" as const, content: "You are playing NYT Connections..." },
];

describe("runAssistStep", () => {
  const generateTextMock = vi.hoisted(() => vi.fn());

  vi.mock("ai", () => ({
    generateText: generateTextMock,
    NoObjectGeneratedError: class NoObjectGeneratedError extends Error {},
    TypeValidationError: class TypeValidationError extends Error {},
    JSONParseError: class JSONParseError extends Error {},
  }));

  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: "reasoning\nANSWER:\nAAAA, BBBB, CCCC, DDDD\nEEEE, FFFF, GGGG, HHHH",
      response: { modelId: "test-model" },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("feeds the full history to the model and returns the raw answer, groups and model", async () => {
    vi.stubEnv("MODEL_CONTEXT_WINDOW", "4096");
    const result = await runAssistStep(MESSAGES);

    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: MESSAGES,
        temperature: 0.7,
      }),
    );
    expect(result.response).toContain("reasoning");
    expect(result.groups).toEqual([
      ["AAAA", "BBBB", "CCCC", "DDDD"],
      ["EEEE", "FFFF", "GGGG", "HHHH"],
    ]);
    expect(result.model).toBe("test-model");
  });

  it("classifies a provider failure as a model_error", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("openai is down"));

    await expect(runAssistStep(MESSAGES)).rejects.toMatchObject({
      code: "model_error",
    });
  });

  it("rejects an answer without an ANSWER: section as invalid_group", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "I don't know the answer",
      response: { modelId: "test-model" },
    });

    const result = runAssistStep(MESSAGES);
    await expect(result).rejects.toBeInstanceOf(SolveError);
    await expect(result).rejects.toMatchObject({
      code: "invalid_group",
    });
  });

  it("classifies malformed output as an invalid_group", async () => {
    const { JSONParseError } = await import("ai");
    generateTextMock.mockRejectedValueOnce(
      new (JSONParseError as unknown as { new (): Error })(),
    );

    await expect(runAssistStep(MESSAGES)).rejects.toMatchObject({
      code: "invalid_group",
    });
  });
});

describe("parseAnswerGroups", () => {
  it("extracts the group lines that follow the ANSWER: line", () => {
    const text = [
      "I think these pair up as:",
      "",
      "ANSWER:",
      "HAIL, RAIN, SLEET, SNOW",
      "BUCKS, HEAT, JAZZ, NETS",
      "OPTION, RETURN, SHIFT, TAB",
      "KAYAK, LEVEL, MOM, RACECAR",
    ].join("\n");

    expect(parseAnswerGroups(text)).toEqual([
      ["HAIL", "RAIN", "SLEET", "SNOW"],
      ["BUCKS", "HEAT", "JAZZ", "NETS"],
      ["OPTION", "RETURN", "SHIFT", "TAB"],
      ["KAYAK", "LEVEL", "MOM", "RACECAR"],
    ]);
  });

  it("ignores reasoning text before ANSWER:, blank lines, and trailing prose", () => {
    const text = [
      "Some reasoning.",
      "More reasoning.",
      "ANSWER:",
      "",
      "AAAA, BBBB, CCCC, DDDD",
      "",
      "EEEE, FFFF, GGGG, HHHH",
      "nothing after those lines",
    ].join("\n");

    expect(parseAnswerGroups(text)).toEqual([
      ["AAAA", "BBBB", "CCCC", "DDDD"],
      ["EEEE", "FFFF", "GGGG", "HHHH"],
    ]);
  });

  it("accepts an ANSWER: line with surrounding whitespace", () => {
    const text = "reasoning\n   ANSWER:   \nAAAA, BBBB, CCCC, DDDD";

    expect(parseAnswerGroups(text)).toEqual([["AAAA", "BBBB", "CCCC", "DDDD"]]);
  });

  it("trims spaces around comma-separated items", () => {
    const text = "ANSWER:\n AAAA , BBBB , CCCC , DDDD ";

    expect(parseAnswerGroups(text)).toEqual([["AAAA", "BBBB", "CCCC", "DDDD"]]);
  });

  it("returns an empty list when there is no ANSWER: line", () => {
    expect(parseAnswerGroups("no answer here")).toEqual([]);
  });
});
