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
  strategyName: string;
  isOpen: boolean;
  onToggle: () => void;
}

type FetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; run: StrategyRunDetail }
  | { status: "error"; message: string };

export function GuessSequencePanel({
  date,
  strategyName,
  isOpen,
  onToggle,
}: GuessSequencePanelProps) {
  const [state, setState] = useState<FetchState>({ status: "idle" });

  useEffect(() => {
    // Only fetch once the user actually opens the panel — and re-fetch
    // whenever the date changes while it's open, since navigating dates
    // doesn't unmount this component.
    if (!isOpen) return;

    let cancelled = false;
    setState({ status: "loading" });

    fetch(
      `${import.meta.env.VITE_API_URL}/strategy/${strategyName}/puzzle/${date}`,
    )
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(
            body?.message ?? `Request failed with status ${res.status}`,
          );
        }
        return res.json() as Promise<StrategyRunDetail>;
      })
      .then((run) => {
        if (cancelled) return;
        setState({ status: "loaded", run });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setState({ status: "error", message: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, date, strategyName]);

  return (
    <section className="guess-sequence">
      <button
        type="button"
        className="guess-sequence__toggle"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        {isOpen ? "Hide" : "Show"} {strategyName} strategy guesses
      </button>

      {isOpen && (
        <div className="guess-sequence__content">
          {state.status === "loading" && <p>Loading guesses...</p>}

          {state.status === "error" && (
            <p className="guess-sequence__error">{state.message}</p>
          )}

          {state.status === "loaded" && (
            <>
              <p className="guess-sequence__status">
                Status: {state.run.status} · {state.run.guesses.length} guess
                {state.run.guesses.length === 1 ? "" : "es"}
              </p>
              <ol className="guess-sequence__list">
                {state.run.guesses.map((guess) => (
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
