import { useState, useEffect } from "react";
import { Board } from "./Board";
import { CategoryReveal } from "./CategoryReveal";
import { GameOverModal } from "./GameOverModal";
import { MistakeTracker } from "./MistakeTracker";
import { shuffleWords, type Puzzle } from "../data/types";
import { useConnectionsGame } from "../hooks/useConnectionsGame";

const MAX_MISTAKES = 4;

interface GameProps {
  puzzle: Puzzle;
}

export function Game({ puzzle }: GameProps) {
  const [initialWords] = useState(
    () => puzzle.wordOrder || shuffleWords(puzzle.categories),
  );

  const {
    state,
    toggleWord,
    submitGuess,
    deselectAll,
    clearFeedback,
    shuffleBoard,
    aiSolve,
    aiSolveSuccess,
    aiSolveError,
    confirmSolve,
  } = useConnectionsGame(puzzle.categories, initialWords);

  const [modalDismissed, setModalDismissed] = useState(false);

  useEffect(() => {
    if (!state.feedback) return;
    const timeoutId = setTimeout(clearFeedback, 1500);
    return () => clearTimeout(timeoutId);
  }, [state.feedback, clearFeedback]);

  useEffect(() => {
    if (!state.pendingSolve) return;
    const timeoutId = setTimeout(confirmSolve, 700);
    return () => clearTimeout(timeoutId);
  }, [state.pendingSolve, confirmSolve]);

  // Effect: Triggers when AI_SOLVE_START sets state.isAiSolving to true
  useEffect(() => {
    if (!state.loading) return;

    const controller = new AbortController();
    // Backend has its own 5s timeout calling the orchestrator; give it a
    // little headroom before we give up on the whole round trip and show
    // our own timeout message instead of spinning forever.
    const timeoutId = setTimeout(() => controller.abort("timeout"), 8000);

    async function fetchAiSolve() {
      try {
        const response = await fetch(
          `${import.meta.env.VITE_API_URL}/api/solve`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              puzzleWords: state.remainingWords,
              priorGuesses: state.priorGuesses,
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          throw new Error(`AI service returned HTTP ${response.status}.`);
        }

        const result = await response.json();
        console.log("Raw AI response:", result);

        // The backend responds with HTTP 200 even when the orchestrator
        // call failed or timed out — it reports that as
        // { orchestrator: "unhealthy", error } in the body rather than a
        // non-2xx status. Treat that as a failure too.
        if (result.orchestrator !== "healthy" || !result.data) {
          throw new Error(
            result.error || "AI orchestrator is currently unavailable.",
          );
        }

        aiSolveSuccess(result);
      } catch (err) {
        const error = err as Error;
        if (error.name === "AbortError") {
          if (controller.signal.reason === "timeout") {
            aiSolveError("AI Assist timed out. Please try again.");
          }
          // Otherwise this is the cleanup abort from unmount/dep change —
          // not a real failure, so stay silent as before.
          return;
        }
        aiSolveError(error.message);
      }
    }

    fetchAiSolve();

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [
    state.loading,
    state.remainingWords,
    state.priorGuesses,
    aiSolveSuccess,
    aiSolveError,
  ]);

  const canSubmit = state.selected.length === 4 && state.status === "playing";

  return (
    <div className="app">
      <h1>Connections</h1>

      <CategoryReveal solved={state.solved} />

      {state.feedback === "one-away" && (
        <p className="feedback feedback--one-away">One away...</p>
      )}
      {state.feedback === "incorrect" && (
        <p className="feedback feedback--incorrect">Not quite.</p>
      )}

      <p className="status">
        {state.status === "won" && "You solved it!"}
        {state.status === "lost" && "Out of guesses."}
        {state.status === "playing" && `${state.selected.length}/4 selected`}
      </p>

      <MistakeTracker mistakes={state.mistakes} maxMistakes={MAX_MISTAKES} />

      <Board
        words={state.remainingWords}
        selected={state.selected}
        shakeWords={state.shakeWords}
        confirmedWords={state.pendingSolve?.words ?? []}
        onToggle={toggleWord}
      />

      {state.status === "playing" && (
        <div className="controls">
          <button type="button" onClick={aiSolve} disabled={state.loading}>
            {state.loading ? "Thinking..." : "AI Assist"}
          </button>
          <button type="button" onClick={shuffleBoard}>
            Shuffle
          </button>
          <button
            type="button"
            onClick={deselectAll}
            disabled={state.selected.length === 0}
          >
            Deselect all
          </button>
          <button type="button" onClick={submitGuess} disabled={!canSubmit}>
            Submit
          </button>
        </div>
      )}

      {state.error && (
        <div
          className="ai-error-banner"
          role="alert"
          style={{
            backgroundColor: "#3a1414",
            color: "#ffb4b4",
            border: "1px solid #7a2b2b",
            borderRadius: "10px",
            padding: "0.85rem 1.1rem",
            margin: "1rem auto",
            maxWidth: "480px",
            textAlign: "left",
          }}
        >
          <strong>AI Assist unavailable:</strong> {state.error}
        </div>
      )}

      {state.ai_solution && (
        <div className="ai-solution-container">
          <h3>AI Recommendation:</h3>
          <pre
            style={{
              backgroundColor: "#1e1e1e",
              color: "#d4d4d4",
              padding: "1.25rem",
              borderRadius: "12px",
              textAlign: "left",
              fontFamily: "monospace",
              fontSize: "0.9rem",

              /* Enables line wrapping while preserving indentations */
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowWrap: "anywhere",
            }}
          >
            {JSON.stringify(state.ai_solution.proposedGroup, null, 2)}
          </pre>

          {state.ai_solution.prompt && (
            <details className="ai-prompt-details">
              <summary style={{ cursor: "pointer" }}>
                View prompt sent to the model
              </summary>
              <pre
                style={{
                  backgroundColor: "#1e1e1e",
                  color: "#d4d4d4",
                  padding: "1.25rem",
                  borderRadius: "12px",
                  textAlign: "left",
                  fontFamily: "monospace",
                  fontSize: "0.85rem",
                  marginTop: "0.5rem",

                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  overflowWrap: "anywhere",
                }}
              >
                {state.ai_solution.prompt}
              </pre>
            </details>
          )}
        </div>
      )}

      {(state.status === "won" || state.status === "lost") &&
        !modalDismissed && (
          <GameOverModal
            status={state.status}
            categories={puzzle.categories}
            guessHistory={state.guessHistory}
            puzzleDate={puzzle.date}
            onClose={() => setModalDismissed(true)}
          />
        )}
    </div>
  );
}
