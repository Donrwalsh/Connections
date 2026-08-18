import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { RunHistoryTable } from "../../components/benchmark/RunHistoryTable";
import { StatusPill } from "../../components/benchmark/StatusPill";
import { fetchLeaderboard, fetchRunHistory } from "../../data/benchmark/api";
import { formatCostUsd, formatDuration } from "../../data/benchmark/metrics";
import { useStrategyMeta } from "../../data/benchmark/useStrategyMeta";
import type {
  LeaderboardRow,
  RunHistory,
  RunHistorySortBy,
  RunHistorySortDir,
} from "../../data/benchmark/types";

const PAGE_SIZE = 100;

/**
 * Run history for one strategy (or, for "llm" kind rows, one model) across
 * every puzzle — one row per individual run, server-sorted and paginated at
 * PAGE_SIZE, rather than the old mockup's one-row-per-puzzle rollup (that
 * assumed every strategy ran a fixed number of trials per puzzle, which
 * doesn't hold once LLM trial counts vary by model). The same
 * RunHistoryTable renders every strategy kind; LLM rows get an extra Token
 * cost column.
 *
 * Header summary stats come from GET /strategy/leaderboard (the same data
 * backing the leaderboard table) rather than a dedicated endpoint — it's
 * fetched once per strategyId and matched by row id. That fetch is
 * best-effort: a miss (e.g. a strategy with zero runs, or the fetch racing
 * the run-history one) just leaves the summary stats blank instead of
 * blocking the page, since the run-history table is the page's actual
 * content.
 */
export function StrategyPuzzlePage() {
  const { strategyId } = useParams();
  const { meta, isResolving: isResolvingMeta } = useStrategyMeta(strategyId);
  const resolvedStrategyName = meta?.strategyName;
  const resolvedKind = meta?.kind;
  const resolvedModelId = meta?.id;

  const [leaderboardRow, setLeaderboardRow] = useState<LeaderboardRow | null>(null);
  const [history, setHistory] = useState<RunHistory | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<RunHistorySortBy>("puzzleDate");
  const [sortDir, setSortDir] = useState<RunHistorySortDir>("desc");

  useEffect(() => {
    if (!strategyId) return;

    const controller = new AbortController();
    fetchLeaderboard(controller.signal)
      .then((data) => {
        const row = [...data.deterministic, ...data.llm].find((r) => r.id === strategyId);
        setLeaderboardRow(row ?? null);
      })
      .catch(() => {
        // Best-effort — see the header comment above.
      });

    return () => controller.abort();
  }, [strategyId]);

  useEffect(() => {
    if (!resolvedStrategyName) return;

    setIsLoading(true);
    setError(null);

    const controller = new AbortController();
    fetchRunHistory(
      resolvedStrategyName,
      {
        model: resolvedKind === "llm" ? resolvedModelId : undefined,
        page,
        limit: PAGE_SIZE,
        sortBy,
        sortDir,
      },
      controller.signal,
    )
      .then((data) => {
        setHistory(data);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load runs");
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [resolvedStrategyName, resolvedKind, resolvedModelId, page, sortBy, sortDir]);

  function handleSortChange(newSortBy: RunHistorySortBy) {
    setPage(1);
    if (sortBy === newSortBy) {
      setSortDir((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(newSortBy);
      setSortDir("desc");
    }
  }

  if (!strategyId) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown strategy.</p>
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Back to leaderboard
        </Link>
      </div>
    );
  }

  if (!meta) {
    if (isResolvingMeta) {
      return (
        <div className="bench-page">
          <p className="bench-muted">Loading…</p>
        </div>
      );
    }
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown strategy.</p>
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Back to leaderboard
        </Link>
      </div>
    );
  }

  const totalPages = history ? Math.max(1, Math.ceil(history.meta.total / history.meta.limit)) : 1;

  return (
    <div className="bench-page">
      <header className="bench-page-header">
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Leaderboard
        </Link>
        <h1 className="bench-page-header__title">{meta.name}</h1>
        <p className="bench-strategy-desc">{meta.description}</p>

        {leaderboardRow ? (
          <>
            <div className="bench-summary">
              <span className="bench-summary__item">
                Success rate
                <span className="bench-mono">
                  {leaderboardRow.successRate === null
                    ? "—"
                    : `${Math.round(leaderboardRow.successRate)}%`}
                </span>
              </span>
              <span className="bench-summary__item">
                Avg cost
                <span className="bench-mono">
                  {leaderboardRow.avgCostUsd === null ? "—" : formatCostUsd(leaderboardRow.avgCostUsd)}
                </span>
              </span>
              <span className="bench-summary__item">
                Total cost
                <span className="bench-mono">
                  {leaderboardRow.totalCostUsd === null
                    ? "—"
                    : formatCostUsd(leaderboardRow.totalCostUsd)}
                </span>
              </span>
              <span className="bench-summary__item">
                Avg guesses
                <span className="bench-mono">
                  {leaderboardRow.avgGuessesToSolve === null
                    ? "—"
                    : leaderboardRow.avgGuessesToSolve.toLocaleString(undefined, {
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      })}
                </span>
              </span>
              <span className="bench-summary__item">
                Avg duration
                <span className="bench-mono">
                  {leaderboardRow.avgDurationMs === null
                    ? "—"
                    : formatDuration(leaderboardRow.avgDurationMs)}
                </span>
              </span>
              <span className="bench-summary__item">
                Puzzles
                <span className="bench-mono">
                  {leaderboardRow.puzzlesCovered.toLocaleString()} /{" "}
                  {leaderboardRow.totalPuzzles.toLocaleString()}
                </span>
              </span>
            </div>
            <div className="bench-badges">
              {leaderboardRow.progress.queued > 0 ? (
                <StatusPill
                  label={`Queued ${leaderboardRow.progress.queued.toLocaleString()}`}
                  tone="queued"
                />
              ) : null}
              {leaderboardRow.progress.active > 0 ? (
                <StatusPill
                  label={`Active ${leaderboardRow.progress.active.toLocaleString()}`}
                  tone="active"
                />
              ) : null}
              {leaderboardRow.progress.failed > 0 ? (
                <StatusPill
                  label={`Failed ${leaderboardRow.progress.failed.toLocaleString()}`}
                  tone="failed"
                />
              ) : null}
            </div>
          </>
        ) : null}
      </header>

      {isLoading ? <p className="bench-muted">Loading runs…</p> : null}
      {error && !isLoading ? <p className="bench-error">{error}</p> : null}

      {!isLoading && !error && history ? (
        <>
          <RunHistoryTable
            strategyId={strategyId}
            rows={history.rows}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            showTokenCost={resolvedKind === "llm"}
          />
          <div className="bench-controls">
            <button
              type="button"
              className="bench-sort-btn"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={page <= 1}
            >
              ← Prev
            </button>
            <span className="bench-mono">
              Page {page} of {totalPages} · {history.meta.total.toLocaleString()} runs
            </span>
            <button
              type="button"
              className="bench-sort-btn"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={page >= totalPages}
            >
              Next →
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
