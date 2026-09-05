import { useEffect, useState } from "react";
import { fetchSupportedModels } from "./api";
import { formatModelStatsDescription } from "./formatModelStats";
import { getStrategyMeta } from "./mockData";
import type { StrategyMeta, SupportedModelRecord } from "./types";

/** Synthesizes StrategyMeta for a model the static mock catalog doesn't know
 * about, from the real backend allowlist (GET /strategy/models). Only ever
 * needed for LLM rows — deterministic/shuffle strategies are always in the
 * mock catalog already. `runsPerPuzzle` is a placeholder: nothing derives
 * layout from it, so it isn't load-bearing here. */
function buildDynamicMeta(model: SupportedModelRecord): StrategyMeta {
  const providerLabel =
    model.strategyName === "llm-ollama"
      ? "Ollama"
      : model.strategyName === "llm-google"
        ? "Google"
        : model.strategyName === "llm-groq"
          ? "Groq"
          : "OpenAI";
  return {
    id: model.modelName,
    name: `LLM · ${model.modelName}`,
    kind: "llm",
    description: formatModelStatsDescription(
      providerLabel,
      model.modelName,
      model.contextWindow,
      model.paramCount,
    ),
    runsPerPuzzle: 3,
    strategyName: model.strategyName,
  };
}

/**
 * Resolves a /leaderboard/:strategyId route param to its StrategyMeta. For
 * "llm" kind rows the id is actually a *model name*
 * (e.g. "gpt-4.1-nano-2025-04-14") — see StrategyMeta. Strategy metadata
 * (name/kind/description) primarily comes from the static mock catalog,
 * since the backend has no general "strategy catalog" and that content is
 * effectively UI copy rather than run data; an id the mock list doesn't
 * recognize is checked against the real model allowlist (GET
 * /strategy/models) before giving up — this is what makes a link generated
 * from real backend data (e.g. a model added after the mock list was last
 * updated) resolve correctly instead of always reporting "Unknown strategy".
 * Shared by every /leaderboard/:strategyId... page.
 */
export function useStrategyMeta(strategyId: string | undefined): {
  meta: StrategyMeta | undefined;
  isResolving: boolean;
} {
  const staticMeta = strategyId ? getStrategyMeta(strategyId) : undefined;
  const [dynamicMeta, setDynamicMeta] = useState<StrategyMeta | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  // For an LLM row, description always comes from live data once it
  // resolves (identity/copy — name/kind/strategyName — stays static); for
  // everything else the static entry is authoritative as-is.
  const meta =
    staticMeta && staticMeta.kind === "llm"
      ? dynamicMeta
        ? { ...staticMeta, description: dynamicMeta.description }
        : staticMeta
      : (staticMeta ?? dynamicMeta ?? undefined);

  // Resolves live model data for every LLM row — either to synthesize a
  // full StrategyMeta (when the static mock catalog doesn't recognize
  // strategyId at all) or just to source a live, non-stale description for
  // one the catalog does recognize. Skipped entirely for non-LLM rows,
  // which are always fully described by the static catalog.
  useEffect(() => {
    const knownNonLlm = staticMeta && staticMeta.kind !== "llm";
    if (!strategyId || knownNonLlm) {
      setDynamicMeta(null);
      setIsResolving(false);
      return;
    }

    setIsResolving(true);
    setDynamicMeta(null);

    const controller = new AbortController();
    fetchSupportedModels(controller.signal)
      .then((models) => {
        const match = models.find((model) => model.modelName === strategyId);
        setDynamicMeta(match ? buildDynamicMeta(match) : null);
      })
      .catch(() => {
        // Best-effort fallback, not a hard requirement — falls through to
        // the "Unknown strategy" state below like any other miss.
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsResolving(false);
      });

    return () => controller.abort();
  }, [strategyId]);

  return { meta, isResolving };
}
