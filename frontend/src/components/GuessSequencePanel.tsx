import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchRunDetailByStrategyDate, fetchRunsForStrategyDate } from "../data/benchmark/api";
import {
  PROVIDER_POOLS,
  poolFromStrategyName,
  providerPoolLabel,
} from "../data/benchmark/providerPools";
import { useResource } from "../hooks/useResource";
import { useResources } from "../hooks/useResources";
import type { GuessResultValue, StrategyRunDetail, StrategyRunListItem } from "../data/benchmark/types";

interface GuessSequencePanelProps {
  date: string;
  puzzleId: number;
  isOpen: boolean;
  onToggle: () => void;
}

// The deterministic + shuffle strategies always get a toggle button. Their
// names are stable, so this half stays a local literal; only the provider
// half below is derived.
const BASE_STRATEGIES: { id: string; label: string }[] = [
  { id: "alphabetical", label: "Alphabetical" },
  { id: "reverse-alphabetical", label: "Rev-Alphabetical" },
  { id: "order", label: "Order" },
  { id: "reverse-order", label: "Rev-Order" },
  { id: "shuffle-smart", label: "Shuffle-Smart" },
  { id: "shuffle-foolish", label: "Shuffle-Foolish" },
];

// One toggle per LLM provider pool, in PROVIDER_POOLS order, derived so a
// provider added to providerPools.ts (and wired up in the backend) shows up
// here automatically instead of silently going missing. Unlike the base
// strategies, a provider button only renders once its run list has loaded
// with at least one run for the current puzzle — see the map() below.
const PROVIDER_STRATEGIES: { id: string; label: string }[] = PROVIDER_POOLS.map(
  (pool) => ({ id: pool.strategyName, label: `LLM · ${pool.label}` }),
);

const STRATEGIES = [...BASE_STRATEGIES, ...PROVIDER_STRATEGIES];

const PROVIDER_STRATEGY_IDS = new Set(PROVIDER_STRATEGIES.map((strat) => strat.id));

const STRATEGY_IDS = STRATEGIES.map((strat) => strat.id);

export function GuessSequencePanel({
  date,
  puzzleId,
  isOpen,
  onToggle,
}: GuessSequencePanelProps) {
  const [activeStrategy, setActiveStrategy] = useState<string>("alphabetical");
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  // Per-run detail is fetched lazily when a run is selected (full guess arrays
  // are heavy — a deterministic run can hold ~2,400 guesses), then cached by
  // run id so reselecting an already-fetched run doesn't refetch it.
  const [detailCache, setDetailCache] = useState<
    Record<number, StrategyRunDetail>
  >({});

  // Fetch strategy run lists on mount (or date change), regardless of isOpen
  // state. The list is deliberately slim (no guess arrays) so every strategy
  // — the base set plus each provider pool — loads in a single parallel round
  // of small requests. The provider lists are fetched even though most will
  // come back empty: the panel needs them to decide which provider toggles to
  // show.
  const strategyResults = useResources(
    date,
    STRATEGY_IDS,
    (strategyId, signal) => fetchRunsForStrategyDate(strategyId, date, signal),
    { enabled: !!date },
  );

  // Selection resets whenever the run lists themselves get refetched for a
  // new date, matching the previous reset-on-date-change effect.
  useEffect(() => {
    setDetailCache({});
    setActiveRunId(null);
  }, [date]);

  // A provider tab can only be selected while its button is showing, but if
  // the date then changes to a puzzle that provider never attempted, its
  // button disappears and the panel would strand on a tab with no toggle.
  // Fall back to the first base strategy once we know the active provider has
  // no runs for this puzzle.
  useEffect(() => {
    if (!PROVIDER_STRATEGY_IDS.has(activeStrategy)) return;
    const runs = strategyResults[activeStrategy]?.data;
    if (runs && runs.length === 0) {
      setActiveStrategy(BASE_STRATEGIES[0].id);
    }
  }, [activeStrategy, strategyResults]);

  const currentRuns = strategyResults[activeStrategy]?.data ?? [];
  const selectedRun =
    currentRuns.find((run) => run.id === activeRunId) ?? currentRuns[0] ?? null;

  const cachedDetail = selectedRun ? detailCache[selectedRun.id] : undefined;

  // Lazy-load the full guess list for the selected run, but only while the
  // panel is open and only when this run isn't already cached below.
  const {
    data: fetchedDetail,
    loading: selectedDetailLoading,
    error: selectedDetailErrorObj,
  } = useResource(
    ["runDetail", selectedRun?.strategyName, date, selectedRun?.trialNumber],
    (signal) => {
      if (!selectedRun) return Promise.reject(new Error("No run selected"));
      return fetchRunDetailByStrategyDate(selectedRun.strategyName, date, selectedRun.trialNumber, signal);
    },
    { enabled: isOpen && !!date && !!selectedRun && !cachedDetail },
  );

  useEffect(() => {
    if (!fetchedDetail || !selectedRun) return;
    const id = selectedRun.id;
    setDetailCache((prev) => (prev[id] === fetchedDetail ? prev : { ...prev, [id]: fetchedDetail }));
  }, [fetchedDetail, selectedRun]);

  const selectedDetail = cachedDetail ?? fetchedDetail;
  const selectedDetailError = selectedDetailErrorObj?.message;

  const handleStrategyClick = (strategyId: string) => {
    if (isOpen && activeStrategy === strategyId) {
      onToggle();
    } else {
      if (strategyId !== activeStrategy) {
        setActiveRunId(null);
      }
      setActiveStrategy(strategyId);
      if (!isOpen) {
        onToggle();
      }
    }
  };

  const isLoadingCurrent = strategyResults[activeStrategy]?.loading;
  const currentError = strategyResults[activeStrategy]?.error?.message;

  const averageGuesses = (runs: StrategyRunListItem[]) => {
    if (runs.length === 0) return null;
    const total = runs.reduce((sum, run) => sum + run.guessCount, 0);
    const average = total / runs.length;
    return Number.isInteger(average) ? String(average) : average.toFixed(1);
  };

  return (
    <section className="guess-sequence">
      <div className="guess-sequence__header-actions">
        {STRATEGIES.map((strat) => {
          const runs = strategyResults[strat.id]?.data;
          // Provider toggles only appear once their run list has resolved with
          // at least one run for this puzzle; the base deterministic/shuffle
          // strategies always get a button.
          if (PROVIDER_STRATEGY_IDS.has(strat.id) && !(runs && runs.length > 0)) {
            return null;
          }
          const isActive = isOpen && activeStrategy === strat.id;
          const isLoading = strategyResults[strat.id]?.loading;
          const stepCount = runs ? averageGuesses(runs) : null;

          return (
            <button
              key={strat.id}
              type="button"
              className={`guess-sequence__toggle ${
                isActive ? "guess-sequence__toggle--active" : ""
              }`}
              onClick={() => handleStrategyClick(strat.id)}
              aria-expanded={isActive}
            >
              {isActive ? "Hide" : "Show"} {strat.label}
              {stepCount !== null
                ? ` (${stepCount})`
                : isLoading
                  ? " (...)"
                  : ""}
            </button>
          );
        })}
      </div>

      {isOpen && (
        <div className="guess-sequence__content">
          {isLoadingCurrent && (
            <p>Loading {formatStrategyName(activeStrategy)} guesses...</p>
          )}

          {currentError && (
            <p className="guess-sequence__error">{currentError}</p>
          )}

          {!isLoadingCurrent && !currentError && currentRuns.length === 0 && (
            <p className="guess-sequence__empty">
              No runs yet for {formatStrategyName(activeStrategy)}.
            </p>
          )}

          {selectedRun && (
            <>
              {currentRuns.length > 1 && (
                <div className="guess-sequence__trials">
                  {currentRuns.map((run) => (
                    <button
                      key={run.id}
                      type="button"
                      className={`guess-sequence__trial ${
                        run.id === selectedRun.id
                          ? "guess-sequence__trial--active"
                          : ""
                      }`}
                      onClick={() => setActiveRunId(run.id)}
                    >
                      Trial #{run.trialNumber} · {run.status} · {run.guessCount}{" "}
                      guess
                      {run.guessCount === 1 ? "" : "es"}
                      {formatModelDetail(run)
                        ? ` · ${formatModelDetail(run)}`
                        : ""}
                    </button>
                  ))}
                </div>
              )}

              <p className="guess-sequence__status">
                Strategy: {formatStrategyName(selectedRun.strategyName)}
                {formatModelDetail(selectedRun)
                  ? ` · Model: ${formatModelDetail(selectedRun)}`
                  : ""}
                {currentRuns.length > 1
                  ? ` · Trial #${selectedRun.trialNumber}`
                  : ""}{" "}
                · Status: {selectedRun.status} · {selectedRun.guessCount} guess
                {selectedRun.guessCount === 1 ? "" : "es"}
              </p>

              {/* LLM runs route on modelName (the leaderboard's :strategyId
               * for "llm" kind rows is actually a model name — see
               * useStrategyMeta); deterministic/shuffle runs route on their
               * own strategyName, which is already a valid :strategyId in
               * the mock catalog (see mockData.ts). Full guess-by-guess
               * detail (prompts, candidate proposals, telemetry) now lives
               * on the Puzzle Runs Page instead of dropping down inline
               * here. Guard puzzleId too: a stale-cached /game/puzzle/:date
               * response (from before this field existed) would otherwise
               * produce a link to ".../undefined" — see PuzzlePage's fetch. */}
              {Number.isInteger(puzzleId) && (
                <Link
                  to={`/leaderboard/${encodeURIComponent(selectedRun.modelName ?? selectedRun.strategyName)}/${puzzleId}`}
                  className="guess-sequence__run-link"
                >
                  View full run details →
                </Link>
              )}

              {selectedDetailLoading && (
                <p>
                  Loading {formatStrategyName(selectedRun.strategyName)} run
                  detail...
                </p>
              )}

              {selectedDetailError && (
                <p className="guess-sequence__error">{selectedDetailError}</p>
              )}

              {selectedDetail && (
                <ol className="guess-sequence__list">
                  {selectedDetail.guesses.map((guess) => (
                    <li key={guess.sequenceNumber} className="guess-sequence__guess">
                      <div
                        className={`guess-sequence__item guess-sequence__item--${guess.result}`}
                      >
                        <span className="guess-sequence__seq">
                          #{guess.sequenceNumber}
                        </span>
                        <span className="guess-sequence__words">
                          {guess.words.join(", ")}
                        </span>
                        <span className="guess-sequence__result">
                          {formatResult(guess.result)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function formatResult(result: GuessResultValue): string {
  switch (result) {
    case "success":
      return "✓ Correct";
    case "offBy1":
      return "One away";
    case "duplicate":
      return "Duplicate";
    case "failure":
      return "✗ Incorrect";
  }
}

function formatStrategyName(strategyName: string): string {
  const pool = poolFromStrategyName(strategyName);
  if (pool) return `LLM · ${providerPoolLabel(pool)}`;
  return strategyName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// The model that produced a run's guesses (LLM runs only). Includes the
// context window when it was recorded, e.g. "mistral (2048 ctx)".
function formatModelDetail(run: StrategyRunListItem): string {
  if (!run.modelName) return "";
  return run.contextWindow
    ? `${run.modelName} (${run.contextWindow.toLocaleString()} ctx)`
    : run.modelName;
}

