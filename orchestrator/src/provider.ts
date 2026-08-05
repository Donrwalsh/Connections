import { openai } from "@ai-sdk/openai";
import { createOllama } from "ai-sdk-ollama";
import type { LanguageModel } from "ai";

export const DEFAULT_OPENAI_MODEL = "gpt-4o-2024-08-06";
export const DEFAULT_OLLAMA_MODEL = "llama3.2";

export type ModelProvider = "openai" | "ollama";

/**
 * Resolves which model provider to use from the MODEL_PROVIDER env var.
 * Defaults to OpenAI to keep existing behavior unchanged; set it to
 * "ollama" to run models locally against the bundled Ollama service.
 */
export function getModelProvider(): ModelProvider {
  const provider = process.env.MODEL_PROVIDER?.toLowerCase();
  return provider === "ollama" ? "ollama" : "openai";
}

/**
 * Returns the AI SDK language model for the configured provider.
 * Both providers are exposed through the same LanguageModel interface, so
 * solver.ts (and any future callers) never need to know which backend is
 * active. Config is read on every call so a restart isn't needed to flip
 * providers in development.
 */
export function getModel(): LanguageModel {
  if (getModelProvider() === "ollama") {
    const ollama = createOllama({
      baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    });
    return ollama(process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL);
  }

  return openai(process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
}
