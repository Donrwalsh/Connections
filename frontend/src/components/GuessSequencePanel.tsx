import { useEffect, useState } from "react";

type GuessResult = "success" | "failure" | "offBy1";

interface Guess {
  sequenceNumber: number;
  words: string[];
  result: GuessResult;
  guessedAt: string;
}

interface StrategyRunDetail {
  strategyName: string;
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
];

export function GuessSequencePanel({
  date,
  isOpen,
  onToggle,
}: GuessSequencePanelProps) {
  const [activeStrategy, setActiveStrategy] = useState<string>("alphabetical");

  const [strategyRuns, setStrategyRuns] = useState<
    Record<string, StrategyRunDetail | null>
  >({});
  const [loadingStrategies, setLoadingStrategies] = useState<
    Record<string, boolean>
  >({});
  const [errorMessages, setErrorMessages] = useState<Record<string, string>>(
    {},
  );

  // Fetch strategy step counts on mount (or date change), regardless of isOpen state
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
        const run: StrategyRunDetail = await res.json();
        if (!cancelled) {
          setStrategyRuns((prev) => ({ ...prev, [strategyId]: run }));
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

    // Pre-fetch all 4 strategies right away to populate button step counts
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

  const currentRun = strategyRuns[activeStrategy];
  const isLoadingCurrent = loadingStrategies[activeStrategy];
  const currentError = errorMessages[activeStrategy];

  return (
    <section className="guess-sequence">
      <div className="guess-sequence__header-actions">
        {STRATEGIES.map((strat) => {
          const isActive = isOpen && activeStrategy === strat.id;
          const run = strategyRuns[strat.id];
          const isLoading = loadingStrategies[strat.id];
          const stepCount = run?.guesses ? run.guesses.length : null;

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

          {!isLoadingCurrent && currentRun && (
            <>
              <p className="guess-sequence__status">
                Strategy: {formatStrategyName(currentRun.strategyName)} ·
                Status: {currentRun.status} · {currentRun.guesses.length} guess
                {currentRun.guesses.length === 1 ? "" : "es"}
              </p>
              <ol className="guess-sequence__list">
                {currentRun.guesses.map((guess) => (
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
