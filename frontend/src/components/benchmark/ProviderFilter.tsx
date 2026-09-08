import { useSearchParams } from "react-router-dom";
import {
  PROVIDER_POOLS,
  PROVIDER_PARAM,
  selectedProviderPools,
  serializeProviderParam,
  type ProviderPoolId,
} from "../../data/benchmark/providerPools";

/** Multi-select provider-pool filter. State lives entirely in the URL
 * (?provider=groq,mistral) so a filtered view is bookmarkable; unrelated
 * query params are preserved. Renders on both the leaderboard and the
 * activity page. */
export function ProviderFilter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selected = selectedProviderPools(searchParams);

  const toggle = (id: ProviderPoolId) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);

    const nextParams = new URLSearchParams(searchParams);
    const serialized = serializeProviderParam(next);
    if (serialized) nextParams.set(PROVIDER_PARAM, serialized);
    else nextParams.delete(PROVIDER_PARAM);
    setSearchParams(nextParams, { replace: true });
  };

  return (
    <div className="bench-provider-filter" role="group" aria-label="Filter by provider pool">
      {PROVIDER_POOLS.map((pool) => {
        const isOn = selected.has(pool.id);
        return (
          <button
            key={pool.id}
            type="button"
            className={
              isOn
                ? `bench-pill bench-pill--${pool.id} bench-provider-filter__chip is-active`
                : "bench-pill bench-provider-filter__chip"
            }
            aria-pressed={isOn}
            onClick={() => toggle(pool.id)}
          >
            {pool.label}
          </button>
        );
      })}
    </div>
  );
}
