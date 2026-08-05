import { useEffect, useState } from "react";

type GuessResult = "success" | "failure" | "offBy1";

interface Guess {
  sequenceNumber: number;
  words: string[];
  result: GuessResult;
  guessedAt: string;
}

interface StrategyRunDetail {
  id: number;
  strategyName: string;
  trialNumber: number;
  status: "running" | "completed" | "failed";
  guesses: Guess[];
}

interface GuessSequencePanelProps {
  date: string;
  isOpen: boolean;
  onToggle: () => void;
}

const STRATEGIES = [
  { id: "alphabetical", label: "Alphabetical" },
  { id: "reverse-alphabetical", label: "Rev-Alphabetical" },
  { id: "order", label: "Order" },
  { id: "reverse-order", label: "Rev-Order" },
  { id: "shuffle-smart", label: "Shuffle-Smart" },
  { id: "shuffle-foolish", label: "Shuffle-Foolish" },
];

export function GuessSequencePanel({
  date,
  isOpen,
  onToggle,
}: GuessSequencePanelProps) {
  const [activeStrategy, setActiveStrategy] = useState<string>("alphabetical");

  const [strategyRuns, setStrategyRuns] = useState<
    Record<string, StrategyRunDetail[]>
  >({});
  const [loadingStrategies, setLoadingStrategies] = useState<
    Record<string, boolean>
  >({});
  const [errorMessages, setErrorMessages] = useState<Record<string, string>>(
    {},
  );
  const [activeRunId, setActiveRunId] = useState<number | null>(null);

  // Fetch strategy run lists on mount (or date change), regardless of isOpen state
  useEffect(() => {
    if (!date) return;

    let cancelled = false;

    const fetchStrategy = async (strategyId: string) => {
      setLoadingStrategies((prev) => ({ ...prev, [strategyId]: true }));
      setErrorMessages((prev) => ({ ...prev, [strategyId]: "" }));

      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/strategy/${strategyId}/puzzle/${date}`,
        );
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.message ?? `Request failed with status ${res.status}`,
          );
        }
        const runs: StrategyRunDetail[] = await res.json();
        if (!cancelled) {
          setStrategyRuns((prev) => ({ ...prev, [strategyId]: runs }));
        }
      } catch (err: any) {
        if (!cancelled) {
          setErrorMessages((prev) => ({
            ...prev,
            [strategyId]: err.message || "Failed to load strategy",
          }));
        }
      } finally {
        if (!cancelled) {
          setLoadingStrategies((prev) => ({ ...prev, [strategyId]: false }));
        }
      }
    };

    // Pre-fetch all strategies right away to populate button step counts
    STRATEGIES.forEach((strat) => fetchStrategy(strat.id));

    return () => {
      cancelled = true;
    };
  }, [date]); // Triggered as soon as date is passed down

  const handleStrategyClick = (strategyId: string) => {
    if (isOpen && activeStrategy === strategyId) {
      onToggle();
    } else {
      setActiveStrategy(strategyId);
      if (!isOpen) {
        onToggle();
      }
    }
  };

  const currentRuns = strategyRuns[activeStrategy] ?? [];
  const selectedRun =
    currentRuns.find((run) => run.id === activeRunId) ?? currentRuns[0] ?? null;
  const isLoadingCurrent = loadingStrategies[activeStrategy];
  const currentError = errorMessages[activeStrategy];

  const averageGuesses = (runs: StrategyRunDetail[]) => {
    if (runs.length === 0) return null;
    const total = runs.reduce((sum, run) => sum + run.guesses.length, 0);
    const average = total / runs.length;
    return Number.isInteger(average) ? String(average) : average.toFixed(1);
  };

  return (
    <section className="guess-sequence">
      <div className="guess-sequence__header-actions">
        {STRATEGIES.map((strat) => {
          const isActive = isOpen && activeStrategy === strat.id;
          const runs = strategyRuns[strat.id];
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
                      Trial #{run.trialNumber} · {run.status} ·{" "}
                      {run.guesses.length} guess
                      {run.guesses.length === 1 ? "" : "es"}
                    </button>
                  ))}
                </div>
              )}

              <p className="guess-sequence__status">
                Strategy: {formatStrategyName(selectedRun.strategyName)}
                {currentRuns.length > 1
                  ? ` · Trial #${selectedRun.trialNumber}`
                  : ""}{" "}
                · Status: {selectedRun.status} · {selectedRun.guesses.length}{" "}
                guess{selectedRun.guesses.length === 1 ? "" : "es"}
              </p>
              <ol className="guess-sequence__list">
                {selectedRun.guesses.map((guess) => (
                  <li
                    key={guess.sequenceNumber}
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
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function formatResult(result: GuessResult): string {
  switch (result) {
    case "success":
      return "✓ Correct";
    case "offBy1":
      return "One away";
    case "failure":
      return "✗ Incorrect";
  }
}

function formatStrategyName(strategyName: string): string {
  return strategyName
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
