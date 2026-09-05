import { LLM_GOOGLE, LLM_GROQ, LLM_OLLAMA, LLM_OPENAI, LLM_OPENROUTER } from "../../strategies";
import {
  categoryEvalJobId,
  queueForJudgeProvider,
  queueForStrategy,
} from "./strategy.queue";

const openai = { name: "openai" } as never;
const ollama = { name: "ollama" } as never;
const google = { name: "google" } as never;
const groq = { name: "groq" } as never;
const openrouter = { name: "openrouter" } as never;
const shared = { name: "shared" } as never;

describe("queueForStrategy", () => {
  it("routes each LLM strategy to its own queue and everything else to the shared queue", () => {
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_OPENAI)).toBe(openai);
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_OLLAMA)).toBe(ollama);
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_GOOGLE)).toBe(google);
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_GROQ)).toBe(groq);
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, LLM_OPENROUTER)).toBe(
      openrouter,
    );
    expect(queueForStrategy(shared, openai, ollama, google, groq, openrouter, "alphabetical")).toBe(
      shared,
    );
  });
});

describe("queueForJudgeProvider", () => {
  it("maps a judge provider to that provider's LLM queue", () => {
    expect(queueForJudgeProvider("openai", openai, ollama, google)).toBe(openai);
    expect(queueForJudgeProvider("ollama", openai, ollama, google)).toBe(ollama);
    expect(queueForJudgeProvider("google", openai, ollama, google)).toBe(google);
  });
});

describe("categoryEvalJobId", () => {
  it("is deterministic per proposal", () => {
    expect(categoryEvalJobId(42)).toBe("cat-eval-42");
  });
});
