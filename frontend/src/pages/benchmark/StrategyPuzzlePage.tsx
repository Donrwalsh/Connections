import { Link, useParams } from "react-router-dom";
import { PuzzleBreakdownTable } from "../../components/benchmark/PuzzleBreakdownTable";
import { StatusPill } from "../../components/benchmark/StatusPill";
import {
  getStrategyAggregate,
  getStrategyPuzzleBreakdown,
} from "../../data/benchmark/mockData";
import { formatDuration } from "../../data/benchmark/metrics";

/** Breakdown of a single strategy's performance across every ingested puzzle.
 * Puzzle rows navigate to /leaderboard/:strategyId/:puzzleId. */
export function StrategyPuzzlePage() {
  const { strategyId } = useParams();
  const strategy = strategyId ? getStrategyAggregate(strategyId) : undefined;

  if (!strategyId || !strategy) {
    return (
      <div className="bench-page">
        <p className="bench-muted">Unknown strategy.</p>
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Back to leaderboard
        </Link>
      </div>
    );
  }

  const puzzles = getStrategyPuzzleBreakdown(strategyId);
  const { progress } = strategy;

  return (
    <div className="bench-page">
      <header className="bench-page-header">
        <Link to="/leaderboard" className="bench-page-header__back">
          ← Leaderboard
        </Link>
        <h1 className="bench-page-header__title">{strategy.name}</h1>
        <p className="bench-strategy-desc">{strategy.description}</p>
        <div className="bench-summary">
          <span className="bench-summary__item">
            Success rate
            <span className="bench-mono">
              {strategy.successRate === null ? "—" : `${Math.round(strategy.successRate)}%`}
            </span>
          </span>
          <span className="bench-summary__item">
            Avg guesses
            <span className="bench-mono">
              {strategy.avgGuessesToSolve === null ? "—" : strategy.avgGuessesToSolve.toFixed(1)}
            </span>
          </span>
          <span className="bench-summary__item">
            Avg duration
            <span className="bench-mono">
              {strategy.avgDurationMs === null ? "—" : formatDuration(strategy.avgDurationMs)}
            </span>
          </span>
          <span className="bench-summary__item">
            Runs
            <span className="bench-mono">
              {progress.completed} / {strategy.expectedRuns}
            </span>
          </span>
        </div>
        <div className="bench-badges">
          {progress.queued > 0 ? (
            <StatusPill label={`Queued ${progress.queued}`} tone="queued" />
          ) : null}
          {progress.active > 0 ? (
            <StatusPill label={`Active ${progress.active}`} tone="active" />
          ) : null}
          {progress.failed > 0 ? (
            <StatusPill label={`Failed ${progress.failed}`} tone="failed" />
          ) : null}
        </div>
      </header>

      <PuzzleBreakdownTable strategyId={strategyId} puzzles={puzzles} />
    </div>
  );
}
