import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { fetchRunDetailByStrategyDate, fetchRunsForStrategyDate } from "../data/benchmark/api";
import {
  PROVIDER_POOLS,
  poolFromStrategyName,
  providerPoolLabel,
} from "../data/benchmark/providerPools";
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

export function GuessSequencePanel({
  date,
  puzzleId,
  isOpen,
  onToggle,
}: GuessSequencePanelProps) {
  const [activeStrategy, setActiveStrategy] = useState<string>("alphabetical");

  const [strategyRuns, setStrategyRuns] = useState<
    Record<string, StrategyRunListItem[]>
  >({});
  const [loadingStrategies, setLoadingStrategies] = useState<
    Record<string, boolean>
  >({});
  const [errorMessages, setErrorMessages] = useState<Record<string, string>>(
    {},
  );
  const [activeRunId, setActiveRunId] = useState<number | null>(null);
  // Per-run detail is fetched lazily when a run is selected (full guess arrays
  // are heavy — a deterministic run can hold ~2,400 guesses), then cached.
  const [runDetails, setRunDetails] = useState<
    Record<number, StrategyRunDetail>
  >({});
  const [detailLoading, setDetailLoading] = useState<Record<number, boolean>>(
    {},
  );
  const [detailErrors, setDetailErrors] = useState<Record<number, string>>({});

  // Fetch strategy run lists on mount (or date change), regardless of isOpen
  // state. The list is deliberately slim (no guess arrays) so every strategy
  // — the base set plus each provider pool — loads in a single parallel round
  // of small requests. The provider lists are fetched even though most will
  // come back empty: the panel needs them to decide which provider toggles to
  // show.
  useEffect(() => {
    if (!date) return;

    const controller = new AbortController();

    setRunDetails({});
    setDetailLoading({});
    setDetailErrors({});
    setActiveRunId(null);

    const fetchStrategy = async (strategyId: string) => {
      setLoadingStrategies((prev) => ({ ...prev, [strategyId]: true }));
      setErrorMessages((prev) => ({ ...prev, [strategyId]: "" }));

      try {
        const runs = await fetchRunsForStrategyDate(strategyId, date, controller.signal);
        if (!controller.signal.aborted) {
          setStrategyRuns((prev) => ({ ...prev, [strategyId]: runs }));
        }
      } catch (err: unknown) {
        if (
          (err as Error)?.name !== "AbortError" &&
          !controller.signal.aborted
        ) {
          setErrorMessages((prev) => ({
            ...prev,
            [strategyId]:
              err instanceof Error ? err.message : "Failed to load strategy",
          }));
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoadingStrategies((prev) => ({ ...prev, [strategyId]: false }));
        }
      }
    };

    STRATEGIES.forEach((strat) => fetchStrategy(strat.id));

    return () => controller.abort();
  }, [date]); // Triggered as soon as date is passed down

  // A provider tab can only be selected while its button is showing, but if
  // the date then changes to a puzzle that provider never attempted, its
  // button disappears and the panel would strand on a tab with no toggle.
  // Fall back to the first base strategy once we know the active provider has
  // no runs for this puzzle.
  useEffect(() => {
    if (!PROVIDER_STRATEGY_IDS.has(activeStrategy)) return;
    const runs = strategyRuns[activeStrategy];
    if (runs && runs.length === 0) {
      setActiveStrategy(BASE_STRATEGIES[0].id);
    }
  }, [activeStrategy, strategyRuns]);

  const currentRuns = strategyRuns[activeStrategy] ?? [];
  const selectedRun =
    currentRuns.find((run) => run.id === activeRunId) ?? currentRuns[0] ?? null;

  const selectedDetail = selectedRun ? runDetails[selectedRun.id] : undefined;
  const selectedDetailLoading = selectedRun
    ? detailLoading[selectedRun.id]
    : false;
  const selectedDetailError = selectedRun
    ? detailErrors[selectedRun.id]
    : undefined;

  // Ids whose detail is already fetched/cached, so the effect below skips them
  // without reading state it would otherwise have to declare as a dependency.
  const fetchedRunIds = useRef<Set<number>>(new Set());

  // Lazy-load the full guess list for the selected run, but only while the
  // panel is open. Fetches are cached per run and aborted on unmount/switch.
  useEffect(() => {
    if (!isOpen || !date || !selectedRun) return;
    if (fetchedRunIds.current.has(selectedRun.id)) return;

    const controller = new AbortController();
    setDetailLoading((prev) => ({ ...prev, [selectedRun.id]: true }));
    setDetailErrors((prev) => ({ ...prev, [selectedRun.id]: "" }));

    fetchRunDetailByStrategyDate(
      selectedRun.strategyName,
      date,
      selectedRun.trialNumber,
      controller.signal,
    )
      .then((detail: StrategyRunDetail) => {
        if (!controller.signal.aborted) {
          setRunDetails((prev) => ({ ...prev, [selectedRun.id]: detail }));
          fetchedRunIds.current.add(selectedRun.id);
        }
      })
      .catch((err: unknown) => {
        if (
          (err as Error)?.name !== "AbortError" &&
          !controller.signal.aborted
        ) {
          setDetailErrors((prev) => ({
            ...prev,
            [selectedRun.id]:
              err instanceof Error ? err.message : "Failed to load run detail",
          }));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setDetailLoading((prev) => ({ ...prev, [selectedRun.id]: false }));
        }
      });

    return () => controller.abort();
  }, [isOpen, date, selectedRun]);

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

  const isLoadingCurrent = loadingStrategies[activeStrategy];
  const currentError = errorMessages[activeStrategy];

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
          const runs = strategyRuns[strat.id];
          // Provider toggles only appear once their run list has resolved with
          // at least one run for this puzzle; the base deterministic/shuffle
          // strategies always get a button.
          if (PROVIDER_STRATEGY_IDS.has(strat.id) && !(runs && runs.length > 0)) {
            return null;
          }
          const isActive = isOpen && activeStrategy === strat.id;
          const isLoading = loadingStrategies[strat.id];
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

