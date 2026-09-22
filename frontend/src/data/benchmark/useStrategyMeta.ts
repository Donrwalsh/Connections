import { fetchSupportedModels, resolveModelStrategy } from "./api";
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

export interface UseStrategyMetaResult {
  meta: StrategyMeta | undefined;
  isResolving: boolean;
  /** True when `strategyId` names a model more than one provider currently
   * supports and `strategyQualifier` didn't pick one — see
   * ambiguousCandidates for the choices to present. */
  isAmbiguous: boolean;
  /** Populated only when isAmbiguous — every currently-supported
   * SupportedModel row sharing this modelName, for a picker UI to list. */
  ambiguousCandidates: SupportedModelRecord[];
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
 *
 * `strategyQualifier` is the page's `?strategy=` query param (see
 * StrategyTable/RunHistoryTable, which only ever add it for a model name
 * that's actually ambiguous). When given, it picks a row directly — no
 * ambiguity is possible, since the caller already named an exact provider.
 * When absent, an LLM-kind id is resolved through the backend's
 * GET /strategy/models/:modelName/strategy (see resolveModelStrategy) rather
 * than a client-side guess: the backend is the single authority on whether a
 * bare model name has one answer, so its rejection (not a locally-recomputed
 * count) is what flips isAmbiguous — see the design doc's "Frontend
 * resolution flow" section for why this costs one extra request even for the
 * common (non-ambiguous) case.
 */
export function useStrategyMeta(
  strategyId: string | undefined,
  strategyQualifier?: string,
): UseStrategyMetaResult {
  const staticMeta = strategyId ? getStrategyMeta(strategyId) : undefined;
  const knownNonLlm = !!(staticMeta && staticMeta.kind !== "llm");
  const dynamicEnabled = !!strategyId && !knownNonLlm;

  const { data: models, loading: isResolvingModels } = useResource(
    ["supportedModels", strategyId],
    (signal) => fetchSupportedModels(signal),
    { enabled: dynamicEnabled },
  );

  // Only consulted when the URL named no explicit provider — a qualifier
  // already picks a single (strategyName, modelName) row directly below, so
  // there's nothing for the backend to resolve or reject.
  const { data: resolved, loading: isResolvingStrategy, error: resolveError } = useResource(
    ["resolveModelStrategy", strategyId],
    (signal) => resolveModelStrategy(strategyId as string, signal),
    { enabled: dynamicEnabled && !strategyQualifier },
  );

  const resolvedStrategyName = strategyQualifier ?? resolved?.strategyName;
  const match = models?.find(
    (model) => model.modelName === strategyId && model.strategyName === resolvedStrategyName,
  );
  const dynamicMeta = match ? buildDynamicMeta(match) : null;

  // The backend rejected an unqualified resolve — fall back to the
  // already-fetched bulk list to find out *why* and, if it's a real
  // collision, list the candidates. A rejection with 0 or 1 local matches
  // means the model genuinely doesn't exist / isn't supported (a stale
  // link), not an ambiguity — that falls through to the normal "Unknown
  // strategy" state via dynamicMeta staying null.
  const ambiguousCandidates =
    dynamicEnabled && !strategyQualifier && !!resolveError
      ? (models?.filter((model) => model.modelName === strategyId && model.supported) ?? [])
      : [];
  const isAmbiguous = ambiguousCandidates.length > 1;

  // For an LLM row, description always comes from live data once it
  // resolves (identity/copy — name/kind/strategyName — stays static); for
  // everything else the static entry is authoritative as-is.
  const meta =
    staticMeta && staticMeta.kind === "llm"
      ? dynamicMeta
        ? { ...staticMeta, description: dynamicMeta.description }
        : staticMeta
      : (staticMeta ?? dynamicMeta ?? undefined);

  return {
    meta,
    isResolving: isResolvingModels || isResolvingStrategy,
    isAmbiguous,
    ambiguousCandidates,
  };
}
