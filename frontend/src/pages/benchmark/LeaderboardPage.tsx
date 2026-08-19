import { useEffect, useState } from "react";
import { FreeTierBudgetWidget } from "../../components/benchmark/FreeTierBudgetWidget";
import { HeroHeader } from "../../components/benchmark/HeroHeader";
import { MetricSelector } from "../../components/benchmark/MetricSelector";
import { StatusStrip } from "../../components/benchmark/StatusStrip";
import { StrategyTable, type FreeTierModelSets } from "../../components/benchmark/StrategyTable";
import { fetchFreeTierUsage, fetchLeaderboard } from "../../data/benchmark/api";
import type { LeaderboardMetricKey } from "../../data/benchmark/metrics";
import type { Leaderboard, LeaderboardRow } from "../../data/benchmark/types";

const EMPTY_FREE_TIER_MODELS: FreeTierModelSets = { flagship: new Set(), mini: new Set() };

/** Total USD cost (row.totalCostUsd, which is already all-time — not
 * today-scoped like the token budget) across every LLM row whose model
 * belongs to `models`. Null while either input hasn't loaded yet, so the
 * widget can distinguish "not loaded" from "genuinely $0 spent". */
function sumSpendUsd(llmRows: LeaderboardRow[] | null, models: Set<string>): number | null {
  if (llmRows === null || models.size === 0) return null;
  return llmRows.reduce(
    (sum, row) => (row.modelName && models.has(row.modelName) ? sum + (row.totalCostUsd ?? 0) : sum),
    0,
  );
}

/** Homepage of the benchmark area: two DB-driven leaderboard tables (LLM
 * strategies above deterministic/shuffle strategies — see StrategyTable's
 * `variant`) sharing one configurable sort metric. A strategy or model only
 * gets a row once it has an actual run — see GET /strategy/leaderboard.
 * Rows navigate to /leaderboard/:id. */
export function LeaderboardPage() {
  const [leaderboard, setLeaderboard] = useState<Leaderboard | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metricKey, setMetricKey] = useState<LeaderboardMetricKey>("successRate");
  const [freeTierModels, setFreeTierModels] = useState<FreeTierModelSets>(EMPTY_FREE_TIER_MODELS);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    fetchLeaderboard(controller.signal)
      .then((data) => {
        setLeaderboard(data);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load leaderboard");
        setIsLoading(false);
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    // Best-effort: which models belong to which free tier is only used for
    // a small badge, so a failed fetch here just leaves rows unbadged rather
    // than surfacing a page-level error.
    Promise.all([
      fetchFreeTierUsage("flagship", controller.signal),
      fetchFreeTierUsage("mini", controller.signal),
    ])
      .then(([flagship, mini]) => {
        setFreeTierModels({ flagship: new Set(flagship.models), mini: new Set(mini.models) });
      })
      .catch(() => {});

    return () => controller.abort();
  }, []);

  const allRows = leaderboard ? [...leaderboard.deterministic, ...leaderboard.llm] : [];
  const active = allRows.reduce((sum, row) => sum + row.progress.active, 0);
  const queued = allRows.reduce((sum, row) => sum + row.progress.queued, 0);
  const llmRows = leaderboard ? leaderboard.llm : null;
  const flagshipSpentUsd = sumSpendUsd(llmRows, freeTierModels.flagship);
  const miniSpentUsd = sumSpendUsd(llmRows, freeTierModels.mini);

  return (
    <div className="bench-page">
      <HeroHeader />
      <StatusStrip running={active} queued={queued} />
      <div className="bench-free-tiers" aria-label="Daily free-token budgets">
        <FreeTierBudgetWidget tier="flagship" spentUsd={flagshipSpentUsd} />
        <FreeTierBudgetWidget tier="mini" spentUsd={miniSpentUsd} />
      </div>

      {isLoading ? <p className="bench-muted">Loading leaderboard…</p> : null}
      {error && !isLoading ? <p className="bench-error">{error}</p> : null}

      {!isLoading && !error && leaderboard ? (
        <>
          <section className="bench-page__section" aria-label="LLM leaderboard">
            <div className="bench-page__section-head">
              <h2 className="bench-page__section-title">LLM Strategies</h2>
              <MetricSelector value={metricKey} onChange={setMetricKey} />
            </div>
            {leaderboard.llm.length === 0 ? (
              <p className="bench-muted">No LLM runs yet.</p>
            ) : (
              <StrategyTable
                rows={leaderboard.llm}
                metricKey={metricKey}
                variant="llm"
                freeTierModels={freeTierModels}
              />
            )}
          </section>

          <section className="bench-page__section" aria-label="Deterministic and shuffle leaderboard">
            <div className="bench-page__section-head">
              <h2 className="bench-page__section-title">Deterministic &amp; Shuffle</h2>
            </div>
            {leaderboard.deterministic.length === 0 ? (
              <p className="bench-muted">No deterministic or shuffle runs yet.</p>
            ) : (
              <StrategyTable rows={leaderboard.deterministic} metricKey={metricKey} variant="deterministic" />
            )}
          </section>
        </>
      ) : null}

      {/* Out of scope for this pass — see DESIGN.md "Calendar". */}
      <section className="bench-coverage-stub" aria-label="Puzzle coverage calendar">
        <h2 className="bench-coverage-stub__title">Coverage calendar</h2>
        <p className="bench-muted">
          Placeholder — the puzzle-ingestion/coverage calendar will be built
          here next, driven by real data rather than mock fixtures.
        </p>
      </section>
    </div>
  );
}
