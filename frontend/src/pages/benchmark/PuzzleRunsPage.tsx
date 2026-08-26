import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { GuessChainVisualizer } from "../../components/benchmark/GuessChainVisualizer";
import { RunsTable } from "../../components/benchmark/RunsTable";
import { StatusPill } from "../../components/benchmark/StatusPill";
import { fetchPuzzleDate, fetchRunsForPuzzle, toRunRecord } from "../../data/benchmark/api";
import { formatDateLabel } from "../../data/benchmark/mockData";
import { isFailedStatus, puzzleStatusLabel, puzzleStatusTone } from "../../data/benchmark/runStatus";
import { useStrategyMeta } from "../../data/benchmark/useStrategyMeta";
import type { PuzzleRunStatus, RunRecord } from "../../data/benchmark/types";

/**
 * Runs for one strategy (or, for LLM rows, one model) + puzzle, fetched live
 * from the backend — the first page in /leaderboard wired to real data
 * instead of the mock fixtures used elsewhere here (see mockData.ts's header
 * comment). The URL/route param is `:strategyId`, but for "llm" kind rows
 * its value is actually a *model name* (e.g. "gpt-4.1-nano-2025-04-14") —
 * see StrategyMeta. A few judgment calls made while wiring this up, worth
 * revisiting later:
 *
 * - Strategy *metadata* (name/kind/description) primarily comes from the
 *   static mock list, since the backend has no general "strategy catalog"
 *   and that content is effectively UI copy rather than puzzle-run data.
 *   The one exception: an `:strategyId` the mock list doesn't recognize is
 *   checked against the real model allowlist (GET /strategy/models) before
 *   giving up — this is what makes a link generated from real backend data
 *   (e.g. GuessSequencePanel's "View full run details", or a model added
 *   after the mock list was last updated) resolve correctly instead of
 *   always reporting "Unknown strategy" for anything not in the mock's
 *   hardcoded set.
 * - The backend has no per-model query — only per-strategy
 *   ("llm-openai"/"llm-ollama"). So for LLM rows this fetches every run of
 *   the underlying strategy (meta.strategyName) and filters client-side to
 *   the ones whose recorded modelName matches this row's id. A model that's
 *   never actually produced a run for this puzzle renders the normal
 *   "hasn't been run yet" empty state, same as any other strategy.
 * - The puzzle's date (for the header and the "view puzzle" link) is fetched
 *   separately from the runs list and treated as non-critical: if it fails
 *   to load, the rest of the page still renders — just without the date
 *   label/link — rather than blocking on it or surfacing a second error.
 * - The runs-list endpoint returns an empty array both when the puzzleId is
 *   simply unrecognized and when the strategy just hasn't been run for it
 *   yet — those two cases aren't distinguished; both render the same "hasn't
 *   been run yet" empty state rather than a hard error.
 * - Single-run vs. multi-run layout is decided from the *actual* fetched
 *   run count, not the strategy's configured runsPerPuzzle — a strategy
 *   that produced just one run so far renders the single-run view even if
 *   more are expected, since a picker with one row isn't useful.
 */
export function PuzzleRunsPage() {
  const { strategyId, puzzleId: puzzleIdParam } = useParams();
  const puzzleId = Number(puzzleIdParam);
  const isValidPuzzleId = Number.isInteger(puzzleId);

  const { meta, isResolving: isResolvingMeta } = useStrategyMeta(strategyId);
  // Stable primitives (not `meta` itself — a fresh object every render for
  // the static-lookup case) so effects below can depend on "is this strategy
  // resolved" without re-firing on every render.
  const resolvedStrategyName = meta?.strategyName;
  const resolvedKind = meta?.kind;
  const resolvedModelId = meta?.id;

  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  // Bumped after a run is deleted (see GuessChainVisualizer's "Delete this
  // run" button) to force the runs-list effect below to refetch — same
  // refreshSignal convention FreeTierDispatchModal/FreeTierBudgetWidget use
  // elsewhere in this codebase.
  const [runsRefreshSignal, setRunsRefreshSignal] = useState(0);

  useEffect(() => {
    if (!resolvedStrategyName || !isValidPuzzleId) return;

    const controller = new AbortController();
    fetchPuzzleDate(puzzleId, controller.signal)
      .then(setDate)
      .catch(() => {
        // Non-critical — the page still works without it, just without the
        // formatted date label and the "view puzzle" link.
      });

    return () => controller.abort();
  }, [resolvedStrategyName, puzzleId, isValidPuzzleId]);

  useEffect(() => {
    if (!resolvedStrategyName || !isValidPuzzleId) return;

    setIsLoading(true);
    setError(null);
    setRuns(null);

    const controller = new AbortController();
    fetchRunsForPuzzle(resolvedStrategyName, puzzleId, controller.signal)
      .then((items) => {
        // LLM rows are keyed by model, but the backend can only filter by
        // strategy — narrow down to this model's own runs here.
        const modelItems =
          resolvedKind === "llm"
            ? items.filter((item) => item.modelName === resolvedModelId)
            : items;
        setRuns(modelItems.map(toRunRecord));
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load runs");
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [
    resolvedStrategyName,
    resolvedKind,
    resolvedModelId,
    puzzleId,
    isValidPuzzleId,
    runsRefreshSignal,
  ]);

  const handleRunDeleted = () => setRunsRefreshSignal((n) => n + 1);

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

  if (!isValidPuzzleId) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown puzzle.</p>
        <Link to={`/leaderboard/${strategyId}`} className="bench-page-header__back">
          ← Back to {meta.name}
        </Link>
      </div>
    );
  }

  return (
    <div className="bench-page">
      <header className="bench-page-header">
        <div className="bench-page-header__nav">
          <Link to={`/leaderboard/${strategyId}`} className="bench-page-header__back">
            ← {meta.name}
          </Link>
          {date ? (
            <Link to={`/puzzle/${date}`} className="bench-page-header__puzzle-link">
              View puzzle ({formatDateLabel(date)}) →
            </Link>
          ) : null}
        </div>
        <h1 className="bench-page-header__title">{meta.name}</h1>
        <p className="bench-page-header__meta">
          Solving puzzle <span className="bench-mono">#{puzzleId}</span>
          {date ? (
            <>
              {" · "}
              <span className="bench-mono">{formatDateLabel(date)}</span>
            </>
          ) : null}
        </p>
        <p className="bench-strategy-desc">{meta.description}</p>
        {runs && runs.length > 0 ? (
          <div className="bench-badges">
            <StatusPill
              label={puzzleStatusLabel(derivePuzzleStatus(runs))}
              tone={puzzleStatusTone(derivePuzzleStatus(runs))}
            />
          </div>
        ) : null}
      </header>

      {isLoading ? <p className="bench-muted">Loading runs…</p> : null}
      {error && !isLoading ? <p className="bench-error">{error}</p> : null}

      {!isLoading && !error && runs && runs.length === 0 ? (
        <p className="bench-muted">{meta.name} hasn't been run for this puzzle yet.</p>
      ) : null}

      {!isLoading && !error && runs && runs.length > 0 ? (
        runs.length === 1 ? (
          <SingleRunView runs={runs} onRunDeleted={handleRunDeleted} />
        ) : (
          <MultiRunView runs={runs} onRunDeleted={handleRunDeleted} />
        )
      ) : null}
    </div>
  );
}

function derivePuzzleStatus(runs: RunRecord[]): PuzzleRunStatus {
  if (runs.every((run) => run.status === "completed")) return "completed";
  if (runs.some((run) => isFailedStatus(run.status))) return "failed";
  return "in_progress";
}

/** A single fetched run: skip the picker and render its visualizer directly. */
function SingleRunView({ runs, onRunDeleted }: { runs: RunRecord[]; onRunDeleted: () => void }) {
  const run = runs[0];
  if (!run) {
    return <p className="bench-muted">No runs yet.</p>;
  }
  return <GuessChainVisualizer runId={run.runId} onDeleted={onRunDeleted} />;
}

/** More than one fetched run: pick a run, then inspect its guess chain. */
function MultiRunView({ runs, onRunDeleted }: { runs: RunRecord[]; onRunDeleted: () => void }) {
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null;

  return (
    <div className="bench-runs">
      <RunsTable
        runs={runs}
        selectedRunId={selectedRun?.runId ?? null}
        onSelectRun={setSelectedRunId}
      />
      {selectedRun ? <GuessChainVisualizer runId={selectedRun.runId} onDeleted={onRunDeleted} /> : null}
    </div>
  );
}
