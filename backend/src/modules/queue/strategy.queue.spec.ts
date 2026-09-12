import { Queue } from "bullmq";

import {
  LLM_GOOGLE,
  LLM_GROQ,
  LLM_MISTRAL,
  LLM_OLLAMA,
  LLM_OPENAI,
  LLM_OPENROUTER,
  LLM_SAMBANOVA,
} from "../../strategies";
import type { ProviderPoolId } from "../provider-pool/provider-pool.config";
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
const mistral = { name: "mistral" } as never;
const sambanova = { name: "sambanova" } as never;
const shared = { name: "shared" } as never;

const runsQueueByPool = new Map<ProviderPoolId, Queue>([
  ["openai", openai],
  ["ollama", ollama],
  ["google", google],
  ["groq", groq],
  ["openrouter", openrouter],
  ["mistral", mistral],
  ["sambanova", sambanova],
]);

describe("queueForStrategy", () => {
  it("routes each LLM strategy to its own queue and everything else to the shared queue", () => {
    expect(queueForStrategy(runsQueueByPool, shared, LLM_OPENAI)).toBe(openai);
    expect(queueForStrategy(runsQueueByPool, shared, LLM_OLLAMA)).toBe(ollama);
    expect(queueForStrategy(runsQueueByPool, shared, LLM_GOOGLE)).toBe(google);
    expect(queueForStrategy(runsQueueByPool, shared, LLM_GROQ)).toBe(groq);
    expect(queueForStrategy(runsQueueByPool, shared, LLM_OPENROUTER)).toBe(openrouter);
    expect(queueForStrategy(runsQueueByPool, shared, LLM_MISTRAL)).toBe(mistral);
    expect(queueForStrategy(runsQueueByPool, shared, LLM_SAMBANOVA)).toBe(sambanova);
    expect(queueForStrategy(runsQueueByPool, shared, "alphabetical")).toBe(shared);
  });

  it("falls back to the shared queue when the pool has no entry in the map", () => {
    expect(queueForStrategy(new Map(), shared, LLM_GROQ)).toBe(shared);
  });
});

describe("queueForJudgeProvider", () => {
  it("maps a judge provider to that provider's run queue — any pool, not just openai/ollama/google", () => {
    expect(queueForJudgeProvider("openai", runsQueueByPool)).toBe(openai);
    expect(queueForJudgeProvider("ollama", runsQueueByPool)).toBe(ollama);
    expect(queueForJudgeProvider("google", runsQueueByPool)).toBe(google);
    expect(queueForJudgeProvider("groq", runsQueueByPool)).toBe(groq);
    expect(queueForJudgeProvider("openrouter", runsQueueByPool)).toBe(openrouter);
    expect(queueForJudgeProvider("mistral", runsQueueByPool)).toBe(mistral);
    expect(queueForJudgeProvider("sambanova", runsQueueByPool)).toBe(sambanova);
  });

  it("throws rather than silently defaulting when the pool has no entry in the map", () => {
    expect(() => queueForJudgeProvider("groq", new Map())).toThrow(
      /No run queue registered for provider pool "groq"/,
    );
  });
});

describe("categoryEvalJobId", () => {
  it("is deterministic per proposal", () => {
    expect(categoryEvalJobId(42)).toBe("cat-eval-42");
  });
});
