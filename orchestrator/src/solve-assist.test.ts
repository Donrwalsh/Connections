import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseGroupProposals, solveAssist } from "./solve-assist.js";

describe("solveAssist", () => {
  const generateTextMock = vi.hoisted(() => vi.fn());

  vi.mock("ai", async (importOriginal) => {
    const actual = await importOriginal<typeof import("ai")>();
    return { ...actual, generateText: generateTextMock };
  });

  const MESSAGES = [{ role: "user" as const, content: "solve this puzzle" }];

  beforeEach(() => {
    generateTextMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("captures the raw request/response detail on a successful call", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "### ANSWER\nAAAA, BBBB, CCCC, DDDD",
      response: {
        modelId: "gpt-4.1-nano",
        id: "resp_123",
        headers: { "x-request-id": "req_123" },
        body: { id: "resp_123", choices: [{ message: { content: "### ANSWER..." } }] },
      },
      request: {
        body: { model: "gpt-4.1-nano", messages: [{ role: "user", content: "solve this puzzle" }] },
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    const result = await solveAssist(MESSAGES);

    expect(result.requestBody).toEqual({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: "solve this puzzle" }],
    });
    expect(result.responseId).toBe("resp_123");
    expect(result.responseHeaders).toEqual({ "x-request-id": "req_123" });
    expect(result.responseBody).toEqual({
      id: "resp_123",
      choices: [{ message: { content: "### ANSWER..." } }],
    });
  });

  it("surfaces APICallError detail instead of discarding it", async () => {
    const { APICallError } = await import("ai");
    generateTextMock.mockRejectedValueOnce(
      new APICallError({
        message: "Rate limit exceeded",
        url: "https://api.openai.com/v1/chat/completions",
        requestBodyValues: { model: "gpt-4.1-nano" },
        statusCode: 429,
        responseHeaders: { "retry-after": "30" },
        responseBody: '{"error":{"message":"Rate limit exceeded"}}',
        isRetryable: true,
      }),
    );

    await expect(solveAssist(MESSAGES)).rejects.toMatchObject({
      code: "model_error",
      details: {
        requestBody: { model: "gpt-4.1-nano" },
        statusCode: 429,
        responseHeaders: { "retry-after": "30" },
        responseBody: '{"error":{"message":"Rate limit exceeded"}}',
        isRetryable: true,
        errorName: "AI_APICallError",
      },
    });
  });

  it("still classifies a plain non-API error as model_error with no call detail", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("fetch failed"));

    await expect(solveAssist(MESSAGES)).rejects.toMatchObject({
      code: "model_error",
      details: { requestBody: undefined, statusCode: undefined },
    });
  });
});

describe("parseGroupProposals", () => {
  it("parses a well-formed Words: line", () => {
    const text = "Group 1\nCategory: Fruits\nWords: APPLE, BANANA, CHERRY, DATE\n";
    expect(parseGroupProposals(text)).toEqual([
      { category: "Fruits", words: ["APPLE", "BANANA", "CHERRY", "DATE"] },
    ]);
  });

  it("strips a trailing parenthetical explanation glued onto the Words: line", () => {
    // Some models (Mistral especially) append their reasoning straight onto
    // the Words: line instead of using the scratchpad — see
    // llm-strategy-runner.service.ts's WORDS_PARENTHETICAL_RE on the
    // backend, which this parser previously lacked (commit cdd6b22 fixed
    // the backend but not this orchestrator-side parser).
    const text =
      "Group 1\nCategory: Senses\nWords: LOOK, TOUCH, SIGHT, SMELL (these are all senses)\n";
    expect(parseGroupProposals(text)).toEqual([
      { category: "Senses", words: ["LOOK", "TOUCH", "SIGHT", "SMELL"] },
    ]);
  });

  it("discards a group whose parenthetical aside itself contains commas, without the fix inflating it past 4 words", () => {
    const text =
      "Group 1\nCategory: Senses\nWords: LOOK, TOUCH, SIGHT, SMELL (these are all senses, e.g. sight, sound)\n";
    expect(parseGroupProposals(text)).toEqual([
      { category: "Senses", words: ["LOOK", "TOUCH", "SIGHT", "SMELL"] },
    ]);
  });

  it("parses multiple groups from a full ### GROUPS section", () => {
    const text = [
      "### GROUPS",
      "Group 1",
      "Category: Fruits",
      "Words: APPLE, BANANA, CHERRY, DATE",
      "Group 2",
      "Category: Senses",
      "Words: LOOK, TOUCH, SIGHT, SMELL (these are all senses)",
      "### ANSWER",
      "APPLE, BANANA, CHERRY, DATE",
      "LOOK, TOUCH, SIGHT, SMELL",
    ].join("\n");

    expect(parseGroupProposals(text)).toEqual([
      { category: "Fruits", words: ["APPLE", "BANANA", "CHERRY", "DATE"] },
      { category: "Senses", words: ["LOOK", "TOUCH", "SIGHT", "SMELL"] },
    ]);
  });
});
