import { openai } from "@ai-sdk/openai";
import { createOllama } from "ai-sdk-ollama";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-nano";
export const DEFAULT_OLLAMA_MODEL = "llama3.2";
export const DEFAULT_GOOGLE_MODEL = "gemini-3.6-flash";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
export const DEFAULT_JUDGE_MODEL = "gpt-4.1-nano";
export const DEFAULT_JUDGE_PROVIDER: ModelProvider = "openai";
export const DEFAULT_CONTEXT_WINDOW = 8192;

export type ModelProvider = "openai" | "ollama" | "google" | "groq";

/**
 * Resolves the default model provider from the MODEL_PROVIDER env var.
 * Defaults to OpenAI to keep existing behavior unchanged; set it to
 * "ollama" to run models locally against the bundled Ollama service,
 * "google" to call Google AI Studio's Gemini models, or "groq" to call
 * Groq's hosted models.
 *
 * Unlike the strategy runs (which select their provider explicitly by
 * strategy name), this default is only used for provider-less requests —
 * e.g. the in-game AI Assist endpoint.
 */
export function defaultProvider(): ModelProvider {
  const provider = process.env.MODEL_PROVIDER?.toLowerCase();
  if (provider === "ollama") return "ollama";
  if (provider === "google") return "google";
  if (provider === "groq") return "groq";
  return "openai";
}

/**
 * Returns the AI SDK language model for the given provider.
 * All three providers are exposed through the same LanguageModel interface,
 * so solver.ts (and any future callers) never need to know which backend is
 * active. Config is read on every call so a restart isn't needed to flip
 * providers in development.
 *
 * `modelOverride` names the exact model to call — set on every strategy-run
 * call (the backend validates it against SupportedModel first), omitted on
 * the provider-less /diagnose AI Assist path, which falls back to the
 * env-configured default. `contextWindow` is the calling model's real
 * context window (from SupportedModel) when the backend knows one — but
 * Ollama's num_ctx is always capped at MODEL_CONTEXT_WINDOW regardless,
 * never requested in full: llama.cpp reserves num_ctx's *entire* KV-cache
 * footprint at model-load time (not scaled to actual prompt length), so
 * requesting a model's real context window verbatim (e.g. a 131K-context
 * model) can OOM-kill Ollama on memory-constrained hardware even though
 * real prompts never come close to using it. The model's true spec still
 * shows correctly everywhere else (SupportedModel.contextWindow, the
 * leaderboard) — only what's actually sent to Ollama is capped. Google has
 * no per-call context-window setting at all, so `contextWindow` is accepted
 * for signature consistency but unused there.
 */
export function getModel(
  provider: ModelProvider,
  modelOverride?: string,
  contextWindow?: number,
): LanguageModel {
  if (provider === "ollama") {
    const ollama = createOllama({
      baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    });
    return ollama(modelOverride ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL, {
      options: { num_ctx: effectiveContextWindow("ollama", contextWindow) },
    });
  }

  if (provider === "google") {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY });
    return google(modelOverride ?? process.env.GOOGLE_MODEL ?? DEFAULT_GOOGLE_MODEL);
  }

  if (provider === "groq") {
    const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
    return groq(modelOverride ?? process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL);
  }

  return openai(modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL);
}

/**
 * The context window actually used for a call — what a caller should report
 * back as ground truth, since it can differ from the `contextWindow` it was
 * given. For ollama this is always capped at MODEL_CONTEXT_WINDOW (see
 * getModel's doc comment for why); for openai there's no cap concept, so
 * whatever was passed in comes back unchanged (undefined if nothing was).
 */
export function effectiveContextWindow(
  provider: ModelProvider,
  contextWindow?: number,
): number | undefined {
  if (provider !== "ollama") return contextWindow;
  const ceiling = getContextWindow();
  return Math.min(contextWindow ?? ceiling, ceiling);
}

/**
 * Returns the model name that will be (or was) used for the given provider —
 * `modelOverride` if given, else OPENAI_MODEL/OLLAMA_MODEL/GOOGLE_MODEL.
 * Unlike `result.response.modelId` this is known even for a failed call, so
 * per-prompt telemetry can always name the model the prompt was sent to.
 */
export function getModelName(provider: ModelProvider, modelOverride?: string): string {
  if (provider === "ollama") {
    return modelOverride ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  }
  if (provider === "google") {
    return modelOverride ?? process.env.GOOGLE_MODEL ?? DEFAULT_GOOGLE_MODEL;
  }
  if (provider === "groq") {
    return modelOverride ?? process.env.GROQ_MODEL ?? DEFAULT_GROQ_MODEL;
  }
  return modelOverride ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
}

/**
 * The Ollama num_ctx ceiling, from MODEL_CONTEXT_WINDOW — never exceeded
 * regardless of a model's real (possibly much larger) context window, since
 * llama.cpp reserves num_ctx's full KV-cache footprint at model-load time
 * rather than scaling it to actual usage. Doubles as the fallback when no
 * per-model contextWindow is known at all (see getModel). Defaults to 8192
 * when not configured.
 */
export function getContextWindow(): number {
  const raw = Number(process.env.MODEL_CONTEXT_WINDOW);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONTEXT_WINDOW;
}
