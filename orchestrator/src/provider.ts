import { openai } from "@ai-sdk/openai";
import { createOllama } from "ai-sdk-ollama";
import type { LanguageModel } from "ai";

export const DEFAULT_OPENAI_MODEL = "gpt-4o-2024-08-06";
export const DEFAULT_OLLAMA_MODEL = "llama3.2";
export const DEFAULT_CONTEXT_WINDOW = 8192;

export type ModelProvider = "openai" | "ollama";

/**
 * Resolves the default model provider from the MODEL_PROVIDER env var.
 * Defaults to OpenAI to keep existing behavior unchanged; set it to
 * "ollama" to run models locally against the bundled Ollama service.
 *
 * Unlike the strategy runs (which select their provider explicitly by
 * strategy name), this default is only used for provider-less requests —
 * e.g. the in-game AI Assist endpoint.
 */
export function defaultProvider(): ModelProvider {
  const provider = process.env.MODEL_PROVIDER?.toLowerCase();
  return provider === "ollama" ? "ollama" : "openai";
}

/**
 * Returns the AI SDK language model for the given provider.
 * Both providers are exposed through the same LanguageModel interface, so
 * solver.ts (and any future callers) never need to know which backend is
 * active. Config is read on every call so a restart isn't needed to flip
 * providers in development.
 */
export function getModel(provider: ModelProvider): LanguageModel {
  if (provider === "ollama") {
    const ollama = createOllama({
      baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    });
    // Pass the configured context window through as num_ctx so Ollama's real
    // context matches the reported MODEL_CONTEXT_WINDOW telemetry value.
    return ollama(process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL, {
      options: { num_ctx: getContextWindow() },
    });
  }

  return openai(process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
}

/**
 * Returns the configured model name for the given provider, from
 * OPENAI_MODEL/OLLAMA_MODEL. Unlike `result.response.modelId` this is known
 * even for a failed call, so per-prompt telemetry can always name the model
 * the prompt was sent to.
 */
export function getModelName(provider: ModelProvider): string {
  if (provider === "ollama") {
    return process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  }
  return process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
}

/**
 * Returns the configured context window for the active model, from
 * MODEL_CONTEXT_WINDOW. Used both to constrain the Ollama model (num_ctx)
 * and to report per-run context capacity in telemetry. Defaults to 8192
 * when not configured.
 */
export function getContextWindow(): number {
  const raw = Number(process.env.MODEL_CONTEXT_WINDOW);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTEXT_WINDOW;
}
