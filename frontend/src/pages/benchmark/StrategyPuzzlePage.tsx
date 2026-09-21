import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAdminAuth } from "../../auth/useAdminAuth";
import { BulkActionModal } from "../../components/benchmark/BulkActionModal";
import { RunHistoryTable } from "../../components/benchmark/RunHistoryTable";
import { StatusPill } from "../../components/benchmark/StatusPill";
import {
  deleteErroredRunsForStrategy,
  fetchErroredRunCountForStrategy,
  fetchLeaderboard,
  fetchRunHistory,
  retryErroredRunsForStrategy,
} from "../../data/benchmark/api";
import { formatCostUsd, formatDuration, formatSuccessRate } from "../../data/benchmark/metrics";
import { useResource } from "../../hooks/useResource";
import { useStrategyMeta } from "../../data/benchmark/useStrategyMeta";
import type {
  RunHistorySortBy,
  RunHistorySortDir,
  RunStatus,
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
  const { isAdmin } = useAdminAuth();

  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<RunHistorySortBy>("puzzleDate");
  const [sortDir, setSortDir] = useState<RunHistorySortDir>("desc");
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [openBulkModal, setOpenBulkModal] = useState<null | "delete" | "retry">(null);

  // Best-effort — see the header comment above; a miss just leaves the
  // summary stats blank, so the fetch's own error is never surfaced.
  const { data: leaderboardData } = useResource(
    ["leaderboard", strategyId],
    (signal) => fetchLeaderboard(signal),
    { enabled: !!strategyId },
  );
  const leaderboardRow = leaderboardData
    ? ([...leaderboardData.deterministic, ...leaderboardData.llm].find((r) => r.id === strategyId) ?? null)
    : null;

  const {
    data: history,
    loading: isLoading,
    error,
    refetch: refetchHistory,
  } = useResource(
    ["runHistory", resolvedStrategyName, resolvedKind, resolvedModelId, page, sortBy, sortDir, status],
    (signal) => {
      if (!resolvedStrategyName) return Promise.reject(new Error("Strategy not resolved"));
      return fetchRunHistory(
        resolvedStrategyName,
        {
          model: resolvedKind === "llm" ? resolvedModelId : undefined,
          page,
          limit: PAGE_SIZE,
          sortBy,
          sortDir,
          status: status ?? undefined,
        },
        signal,
      );
    },
    { enabled: !!resolvedStrategyName },
  );

  // Admin-only bulk retry/delete for every 'error'-status run of this
  // strategy — the fresh count both gates the buttons (hidden at zero) and
  // is re-fetched right before each confirm modal opens (see the onClick
  // handlers below), so the modal's warning text never acts on a stale
  // number.
  const { data: erroredCount, refetch: refetchErroredCount } = useResource(
    ["erroredRunCount", resolvedStrategyName],
    (signal) => {
      if (!resolvedStrategyName) return Promise.reject(new Error("Strategy not resolved"));
      return fetchErroredRunCountForStrategy(resolvedStrategyName, signal);
    },
    { enabled: !!resolvedStrategyName },
  );

  function handleStatusChange(newStatus: RunStatus | null) {
    setPage(1);
    setStatus(newStatus);
  }

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
        {meta.kind === "llm" && leaderboardRow?.providerDescription ? (
          <p className="bench-strategy-provider-desc">{leaderboardRow.providerDescription}</p>
        ) : null}

        {leaderboardRow ? (
          <>
            <div className="bench-summary">
              <span className="bench-summary__item">
                Success rate
                <span className="bench-mono">
                  {leaderboardRow.successRate === null ? "—" : formatSuccessRate(leaderboardRow.successRate)}
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
              {meta.kind === "llm" ? (
                <span className="bench-summary__item">
                  Category IQ
                  <span className="bench-mono">
                    {leaderboardRow.categoryEvaluated === 0
                      ? "not yet evaluated"
                      : formatSuccessRate(leaderboardRow.categoryAccuracy ?? 0)}
                  </span>
                  {leaderboardRow.categoryEvaluated > 0 ? (
                    <span className="bench-muted bench-mono">
                      {leaderboardRow.categoryCorrect} correct · {leaderboardRow.categoryPartial} partial ·{" "}
                      {leaderboardRow.categoryLucky} lucky (of {leaderboardRow.categoryEvaluated})
                    </span>
                  ) : null}
                </span>
              ) : null}
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

        {isAdmin && resolvedStrategyName && (erroredCount?.erroredRuns ?? 0) > 0 ? (
          <div className="bench-visualizer__actions">
            <button
              type="button"
              className="bench-sort-btn"
              onClick={() => {
                void refetchErroredCount();
                setOpenBulkModal("retry");
              }}
            >
              Retry all errored runs
            </button>
            <button
              type="button"
              className="bench-sort-btn bench-sort-btn--danger"
              onClick={() => {
                void refetchErroredCount();
                setOpenBulkModal("delete");
              }}
            >
              Delete all errored runs
            </button>
          </div>
        ) : null}
      </header>

      {isLoading ? <p className="bench-muted">Loading runs…</p> : null}
      {error && !isLoading ? <p className="bench-error">{error.message}</p> : null}

      {!isLoading && !error && history ? (
        <>
          <RunHistoryTable
            strategyId={strategyId}
            rows={history.rows}
            sortBy={sortBy}
            sortDir={sortDir}
            onSortChange={handleSortChange}
            showTokenCost={resolvedKind === "llm"}
            status={status}
            onStatusChange={handleStatusChange}
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

      {openBulkModal === "delete" && resolvedStrategyName ? (
        <BulkActionModal
          title={`Delete all errored runs for ${meta.name}`}
          warning={
            `This permanently deletes ${erroredCount?.erroredRuns ?? "all"} errored run(s) for ` +
            `${meta.name} and every row tied to them. This cannot be undone.`
          }
          confirmLabel="Delete all errored runs"
          action={() => deleteErroredRunsForStrategy(resolvedStrategyName)}
          onClose={() => setOpenBulkModal(null)}
          onDone={() => {
            void refetchErroredCount();
            void refetchHistory();
          }}
        />
      ) : null}

      {openBulkModal === "retry" && resolvedStrategyName ? (
        <BulkActionModal
          title={`Retry all errored runs for ${meta.name}`}
          warning={
            `This queues ${erroredCount?.erroredRuns ?? "all"} errored run(s) for ${meta.name} for ` +
            "manual retry. Retries run asynchronously — refresh this page to see progress."
          }
          confirmLabel="Retry all errored runs"
          action={() => retryErroredRunsForStrategy(resolvedStrategyName)}
          onClose={() => setOpenBulkModal(null)}
          onDone={() => void refetchErroredCount()}
        />
      ) : null}
    </div>
  );
}
