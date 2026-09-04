import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildJudgePrompt, judgeCategory } from "./judge-category.js";

const generateObjectMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObjectMock(...args) };
});
vi.mock("./provider.js", () => ({
  DEFAULT_JUDGE_MODEL: "gpt-4.1-nano",
  DEFAULT_JUDGE_PROVIDER: "openai",
  defaultProvider: () => "openai",
  getModel: () => ({ mock: "model" }),
  getModelName: () => "gpt-4.1-nano",
}));

describe("buildJudgePrompt", () => {
  it("includes both categories and the three verdict definitions, not the words", () => {
    const prompt = buildJudgePrompt("Fruits", "___ COBBLER");
    expect(prompt).toContain('"Fruits"');
    expect(prompt).toContain('"___ COBBLER"');
    expect(prompt).toContain("correct:");
    expect(prompt).toContain("partial:");
    expect(prompt).toContain("lucky:");
  });

  it("escapes quotation marks embedded in a category name instead of colliding with the wrapper quotes", () => {
    const prompt = buildJudgePrompt('WORDS BEFORE "HOUSE"', 'SOUNDS LIKE "CAT"');
    expect(prompt).toContain(JSON.stringify('WORDS BEFORE "HOUSE"'));
    expect(prompt).toContain(JSON.stringify('SOUNDS LIKE "CAT"'));
  });
});

describe("judgeCategory", () => {
  beforeEach(() => generateObjectMock.mockReset());

  it("returns the verdict, rationale, model, and captured call detail", async () => {
    generateObjectMock.mockResolvedValue({
      object: { verdict: "partial", rationale: "Saw fruit, missed the wordplay." },
      usage: { inputTokens: 120, outputTokens: 15, totalTokens: 135 },
      request: { body: { foo: 1 } },
      response: { id: "resp_1", headers: { h: "v" }, body: { ok: true } },
    });

    const result = await judgeCategory("Fruits", "___ COBBLER", "gpt-4.1-nano", "openai");

    expect(result.verdict).toBe("partial");
    expect(result.rationale).toBe("Saw fruit, missed the wordplay.");
    expect(result.model).toBe("gpt-4.1-nano");
    expect(result.usage).toEqual({ promptTokens: 120, completionTokens: 15, totalTokens: 135 });
    expect(result.requestBody).toEqual({ foo: 1 });
    expect(result.responseId).toBe("resp_1");
    expect(result.responseHeaders).toEqual({ h: "v" });
    expect(typeof result.latencyMs).toBe("number");
  });

  it("classifies a model-call failure into a SolveError", async () => {
    generateObjectMock.mockRejectedValueOnce(new Error("boom"));
    await expect(judgeCategory("A", "B", "gpt-4.1-nano", "openai")).rejects.toMatchObject({
      name: "SolveError",
    });
  });

  it("disables the AI SDK's own retry layer (maxRetries: 0)", async () => {
    generateObjectMock.mockResolvedValue({
      object: { verdict: "correct", rationale: "Match." },
      request: {},
      response: {},
    });

    await judgeCategory("Fruits", "___ COBBLER", "gpt-4.1-nano", "openai");

    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0 }),
    );
  });
});
