import { useEffect, useState } from "react";
import { Board } from "./components/Board";
import { CategoryReveal } from "./components/CategoryReveal";
import { GameOverModal } from "./components/GameOverModal";
import { MistakeTracker } from "./components/MistakeTracker";
import { samplePuzzle, shuffleWords } from "./data/samplePuzzle";
import { useConnectionsGame } from "./hooks/Useconnectionsgame";
import "./App.css";

const MAX_MISTAKES = 4;

function App() {
  const [initialWords] = useState(() => shuffleWords(samplePuzzle.categories));
  const {
    state,
    toggleWord,
    submitGuess,
    deselectAll,
    clearFeedback,
    shuffleBoard,
    confirmSolve,
  } = useConnectionsGame(samplePuzzle.categories, initialWords);

  // Purely local UI state — whether the player closed the modal early.
  // Not part of game state since it doesn't affect win/loss logic at all.
  const [modalDismissed, setModalDismissed] = useState(false);

  useEffect(() => {
    if (!state.feedback) return;
    const timeoutId = setTimeout(clearFeedback, 1500);
    return () => clearTimeout(timeoutId);
  }, [state.feedback, clearFeedback]);

  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`${import.meta.env.VITE_API_URL}/api/latest_date`)
      .then((res) => res.json())
      .then(setData)
      .catch((err) => console.error("Error fetching backend:", err));
  }, []);

  // Holds a correct guess in the "confirmed but not yet removed" state
  // briefly, so the tiles visibly register as solved before they exit
  // the board and the reveal row appears — the actual cascading feel.
  useEffect(() => {
    if (!state.pendingSolve) return;
    const timeoutId = setTimeout(confirmSolve, 700);
    return () => clearTimeout(timeoutId);
  }, [state.pendingSolve, confirmSolve]);

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

      {(state.status === "won" || state.status === "lost") &&
        !modalDismissed && (
          <GameOverModal
            status={state.status}
            categories={samplePuzzle.categories}
            guessHistory={state.guessHistory}
            puzzleDate={samplePuzzle.date}
            onClose={() => setModalDismissed(true)}
          />
        )}
      <h2>Backend Response:</h2>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}

export default App;
