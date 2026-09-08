// Which provider "pool" an LLM run belongs to — i.e. which API actually
// served and rate-limited it, which is NOT the same as the model's vendor
// label. `openai/gpt-oss-20b` is an OpenAI-authored model, but it is served
// through Groq, so its pool is "groq". The pool is exactly the dispatching
// strategy (`strategyName` on LeaderboardRow / RecentActivityEvent /
// StrategyMeta), with the "llm-" prefix stripped.

export type ProviderPoolId =
  | "openai"
  | "google"
  | "groq"
  | "openrouter"
  | "mistral"
  | "sambanova"
  | "ollama";

export interface ProviderPool {
  id: ProviderPoolId;
  /** Short provider name shown on the badge/filter chip. */
  label: string;
  /** The dispatching strategy this pool corresponds to. */
  strategyName: string;
}

/** Every pool, in the order badges and filter chips render. Adding a
 * provider strategy to the backend means adding one row here — the pill,
 * the filter chip, and the row description all derive from this list. */
export const PROVIDER_POOLS: ProviderPool[] = [
  { id: "openai", label: "OpenAI", strategyName: "llm-openai" },
  { id: "google", label: "Google", strategyName: "llm-google" },
  { id: "groq", label: "Groq", strategyName: "llm-groq" },
  { id: "openrouter", label: "OpenRouter", strategyName: "llm-openrouter" },
  { id: "mistral", label: "Mistral", strategyName: "llm-mistral" },
  { id: "sambanova", label: "SambaNova", strategyName: "llm-sambanova" },
  { id: "ollama", label: "Ollama", strategyName: "llm-ollama" },
];

const POOL_BY_STRATEGY = new Map<string, ProviderPoolId>(
  PROVIDER_POOLS.map((pool) => [pool.strategyName, pool.id]),
);
const POOL_IDS = new Set<ProviderPoolId>(PROVIDER_POOLS.map((pool) => pool.id));
const LABEL_BY_ID = new Map<ProviderPoolId, string>(
  PROVIDER_POOLS.map((pool) => [pool.id, pool.label]),
);

/** The pool a run/row belongs to, or null for deterministic/shuffle rows
 * and any strategy name that isn't a recognized provider pool. */
export function poolFromStrategyName(
  strategyName: string | null | undefined,
): ProviderPoolId | null {
  if (!strategyName) return null;
  return POOL_BY_STRATEGY.get(strategyName) ?? null;
}

export function providerPoolLabel(id: ProviderPoolId): string {
  return LABEL_BY_ID.get(id) ?? id;
}

function isPoolId(value: string): value is ProviderPoolId {
  return POOL_IDS.has(value as ProviderPoolId);
}

/** Parse a `?provider=` value (comma-separated pool ids) into a set,
 * dropping anything unrecognized so a stale bookmark degrades to a
 * narrower/empty filter rather than an error. */
export function parseProviderParam(raw: string | null | undefined): Set<ProviderPoolId> {
  const out = new Set<ProviderPoolId>();
  if (!raw) return out;
  for (const token of raw.split(",")) {
    const id = token.trim();
    if (id && isPoolId(id)) out.add(id);
  }
  return out;
}

/** The query-string key the provider filter reads and writes. Kept here so
 * every page that reads the same selection imports one constant. */
export const PROVIDER_PARAM = "provider";

/** Read the current provider-pool selection out of a URLSearchParams —
 * shared by ProviderFilter and the pages that filter their rows/events on
 * the same param. */
export function selectedProviderPools(params: URLSearchParams): Set<ProviderPoolId> {
  return parseProviderParam(params.get(PROVIDER_PARAM));
}

/** Serialize a pool-id selection for the URL, always in canonical
 * PROVIDER_POOLS order so the same selection always yields the same
 * (bookmarkable) string. Returns null when nothing is selected, so callers
 * can delete the param entirely. */
export function serializeProviderParam(ids: Iterable<ProviderPoolId>): string | null {
  const selected = new Set(ids);
  const ordered = PROVIDER_POOLS.filter((pool) => selected.has(pool.id)).map((pool) => pool.id);
  return ordered.length > 0 ? ordered.join(",") : null;
}
