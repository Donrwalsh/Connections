import { poolFromStrategyName, providerPoolLabel } from "../../data/benchmark/providerPools";
import { StatusPill } from "./StatusPill";

export interface ProviderPillProps {
  /** The row/run's dispatching strategy — e.g. "llm-groq". */
  strategyName: string | null | undefined;
}

/** Badge for which provider pool served a model/run (see providerPools.ts).
 * Renders nothing for deterministic/shuffle rows or any strategy that isn't
 * a recognized pool, so callers can drop it in unconditionally. */
export function ProviderPill({ strategyName }: ProviderPillProps) {
  const pool = poolFromStrategyName(strategyName);
  if (!pool) return null;
  return (
    <span title={`Served by ${providerPoolLabel(pool)}`}>
      <StatusPill label={providerPoolLabel(pool)} tone={pool} />
    </span>
  );
}
