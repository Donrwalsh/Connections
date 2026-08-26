import { describe, expect, it } from "vitest";
import { formatModelStatsDescription } from "./formatModelStats";

describe("formatModelStatsDescription", () => {
  it("includes both context window and param count when both are known", () => {
    expect(formatModelStatsDescription("Ollama", "mistral-nemo", 131072, 12_000_000_000)).toBe(
      "Ollama mistral-nemo · 131K context · 12B params",
    );
  });

  it("omits the params clause when paramCount is null", () => {
    expect(formatModelStatsDescription("OpenAI", "gpt-4.1-nano", 128000, null)).toBe(
      "OpenAI gpt-4.1-nano · 128K context",
    );
  });

  it("omits the context clause when contextWindow is null", () => {
    expect(formatModelStatsDescription("OpenAI", "gpt-4.1-nano", null, null)).toBe(
      "OpenAI gpt-4.1-nano proposes candidate groups",
    );
  });
});
