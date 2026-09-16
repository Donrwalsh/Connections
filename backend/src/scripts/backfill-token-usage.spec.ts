import { parseUsageFromResponseBody } from "./backfill-token-usage";

describe("parseUsageFromResponseBody", () => {
  it("parses the Responses API shape (input_tokens/output_tokens/output_tokens_details)", () => {
    const responseBody = {
      usage: {
        input_tokens: 2134,
        output_tokens: 16162,
        total_tokens: 18296,
        output_tokens_details: { reasoning_tokens: 16000 },
      },
    };

    expect(parseUsageFromResponseBody(responseBody)).toEqual({
      promptTokens: 2134,
      completionTokens: 16162,
      totalTokens: 18296,
      reasoningTokens: 16000,
    });
  });

  it("parses the Chat Completions shape (prompt_tokens/completion_tokens/completion_tokens_details)", () => {
    const responseBody = {
      usage: {
        prompt_tokens: 500,
        completion_tokens: 1200,
        total_tokens: 1700,
        completion_tokens_details: { reasoning_tokens: 900 },
      },
    };

    expect(parseUsageFromResponseBody(responseBody)).toEqual({
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: 900,
    });
  });

  it("returns null reasoningTokens when the shape has no reasoning breakdown at all", () => {
    const responseBody = {
      usage: { prompt_tokens: 500, completion_tokens: 1200, total_tokens: 1700 },
    };

    expect(parseUsageFromResponseBody(responseBody)).toEqual({
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: null,
    });
  });

  it("returns null when responseBody has no usage object at all", () => {
    expect(parseUsageFromResponseBody({ error: "some gateway error page" })).toBeNull();
    expect(parseUsageFromResponseBody(null)).toBeNull();
    expect(parseUsageFromResponseBody("a raw string body")).toBeNull();
  });
});
