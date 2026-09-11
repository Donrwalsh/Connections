import { fetchSupportedModels } from "./api";
import { formatModelStatsDescription } from "./formatModelStats";
import { useResource } from "../../hooks/useResource";
import { getStrategyMeta } from "./mockData";
import { poolFromStrategyName, providerPoolLabel } from "./providerPools";
import type { StrategyMeta, SupportedModelRecord } from "./types";

/** Synthesizes StrategyMeta for a model the static mock catalog doesn't know
 * about, from the real backend allowlist (GET /strategy/models). Only ever
 * needed for LLM rows — deterministic/shuffle strategies are always in the
 * mock catalog already. `runsPerPuzzle` is a placeholder: nothing derives
 * layout from it, so it isn't load-bearing here. */
function buildDynamicMeta(model: SupportedModelRecord): StrategyMeta {
  const pool = poolFromStrategyName(model.strategyName);
  const providerLabel = pool ? providerPoolLabel(pool) : "LLM";
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
  const knownNonLlm = !!(staticMeta && staticMeta.kind !== "llm");

  // Resolves live model data for every LLM row — either to synthesize a
  // full StrategyMeta (when the static mock catalog doesn't recognize
  // strategyId at all) or just to source a live, non-stale description for
  // one the catalog does recognize. Skipped entirely for non-LLM rows,
  // which are always fully described by the static catalog. Best-effort: a
  // fetch failure just falls through to the "Unknown strategy" state below
  // like any other miss.
  const { data: models, loading: isResolving } = useResource(
    ["supportedModels", strategyId],
    (signal) => fetchSupportedModels(signal),
    { enabled: !!strategyId && !knownNonLlm },
  );
  const match = models?.find((model) => model.modelName === strategyId);
  const dynamicMeta = match ? buildDynamicMeta(match) : null;

  // For an LLM row, description always comes from live data once it
  // resolves (identity/copy — name/kind/strategyName — stays static); for
  // everything else the static entry is authoritative as-is.
  const meta =
    staticMeta && staticMeta.kind === "llm"
      ? dynamicMeta
        ? { ...staticMeta, description: dynamicMeta.description }
        : staticMeta
      : (staticMeta ?? dynamicMeta ?? undefined);

  return { meta, isResolving };
}
