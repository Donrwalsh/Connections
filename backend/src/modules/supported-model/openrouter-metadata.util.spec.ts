import { parseParamCount, parseReleaseDate } from "./openrouter-metadata.util";

describe("parseParamCount", () => {
  it("parses a param count from a slug like mistral-7b-instruct-v0.3", () => {
    expect(parseParamCount("mistralai/mistral-7b-instruct-v0.3")).toBe(7_000_000_000);
  });

  it("parses a param count from a two-digit slug like llama-3.1-8b-instruct", () => {
    expect(parseParamCount("meta-llama/llama-3.1-8b-instruct")).toBe(8_000_000_000);
  });

  it("parses a param count from description prose", () => {
    expect(parseParamCount("A high-performing, industry-standard 7.3B parameter model.")).toBe(
      7_300_000_000,
    );
  });

  it("returns null for a slug with no param count", () => {
    expect(parseParamCount("mistral-nemo")).toBeNull();
  });

  it("returns null when no param count can be found", () => {
    expect(parseParamCount("openai/gpt-4.1-nano")).toBeNull();
    expect(parseParamCount("For tasks that demand low latency.")).toBeNull();
  });
});

describe("parseReleaseDate", () => {
  it("converts a Unix timestamp (seconds) to a Date", () => {
    expect(parseReleaseDate(1744651369)).toEqual(new Date(1744651369 * 1000));
  });
});
