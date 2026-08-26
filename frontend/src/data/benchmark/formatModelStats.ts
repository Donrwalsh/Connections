/** Formats a model's leaderboard description from live context/param data,
 * falling back to the old generic sentence when neither is known yet
 * (a model that hasn't been through a metadata refresh). */
export function formatModelStatsDescription(
  providerLabel: string,
  modelName: string,
  contextWindow: number | null,
  paramCount: number | null,
): string {
  const parts: string[] = [];
  if (contextWindow !== null) {
    parts.push(`${Math.round(contextWindow / 1000)}K context`);
  }
  if (paramCount !== null) {
    parts.push(`${Math.round(paramCount / 1_000_000_000)}B params`);
  }

  if (parts.length === 0) {
    return `${providerLabel} ${modelName} proposes candidate groups`;
  }

  return `${providerLabel} ${modelName} · ${parts.join(" · ")}`;
}
