import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { GuessChainVisualizer } from "../../components/benchmark/GuessChainVisualizer";
import { RunsTable } from "../../components/benchmark/RunsTable";
import { StatusPill } from "../../components/benchmark/StatusPill";
import {
  getPuzzleBreakdown,
  getPuzzleRuns,
  getStrategyMeta,
} from "../../data/benchmark/mockData";
import {
  puzzleStatusLabel,
  puzzleStatusTone,
} from "../../data/benchmark/runStatus";
import type { RunRecord } from "../../data/benchmark/types";

/** Runs for one strategy + puzzle. Single-run strategies (deterministic,
 * runsPerPuzzle === 1) skip the run picker and render the guess-chain
 * visualizer for their single run directly; multi-run strategies list runs
 * and show the visualizer for the selected one. */
export function PuzzleRunsPage() {
  const { strategyId, puzzleId: puzzleIdParam } = useParams();
  const puzzleId = Number(puzzleIdParam);
  const meta = strategyId ? getStrategyMeta(strategyId) : undefined;

  if (!strategyId || !meta) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown strategy.</p>
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Back to leaderboard
        </Link>
      </div>
    );
  }

  const puzzle = getPuzzleBreakdown(strategyId, puzzleId);
  if (!puzzle || !Number.isInteger(puzzleId)) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown puzzle.</p>
        <Link to={`/leaderboard/${strategyId}`} className="bench-page-header__back">
          ← Back to {meta.name}
        </Link>
      </div>
    );
  }

  const runs = getPuzzleRuns(strategyId, puzzleId);

  return (
    <div className="bench-page">
      <header className="bench-page-header">
        <Link to={`/leaderboard/${strategyId}`} className="bench-page-header__back">
          ← {meta.name}
        </Link>
        <h1 className="bench-page-header__title">
          Puzzle <span className="bench-mono">#{puzzle.puzzleId}</span> — {puzzle.label}
        </h1>
        <p className="bench-strategy-desc">{meta.description}</p>
        <div className="bench-badges">
          <StatusPill
            label={puzzleStatusLabel(puzzle.status)}
            tone={puzzleStatusTone(puzzle.status)}
          />
        </div>
      </header>

      {meta.runsPerPuzzle === 1 ? (
        <SingleRunView runs={runs} />
      ) : (
        <MultiRunView runs={runs} />
      )}
    </div>
  );
}

/** Single-run strategies have exactly one run and no picker to show. */
function SingleRunView({ runs }: { runs: RunRecord[] }) {
  const run = runs[0];
  if (!run) {
    return <p className="bench-muted">No runs yet.</p>;
  }
  return <GuessChainVisualizer runId={run.runId} />;
}

/** Multi-run strategies: pick a run, then inspect its guess chain. */
function MultiRunView({ runs }: { runs: RunRecord[] }) {
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? runs[0] ?? null;

  return (
    <div className="bench-runs">
      <RunsTable
        runs={runs}
        selectedRunId={selectedRun?.runId ?? null}
        onSelectRun={setSelectedRunId}
      />
      {selectedRun ? <GuessChainVisualizer runId={selectedRun.runId} /> : null}
    </div>
  );
}
