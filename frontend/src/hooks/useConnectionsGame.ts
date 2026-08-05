import { useCallback, useReducer } from "react";
import type { Category } from "../data/types";
import {
  gameReducer,
  initGameState,
  type AiSolveResponse,
} from "../lib/gameReducer";

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function useConnectionsGame(
  categories: Category[],
  remainingWords: string[],
) {
  const [state, dispatch] = useReducer(
    gameReducer,
    { categories, remainingWords },
    ({ categories, remainingWords }) =>
      initGameState(categories, remainingWords),
  );

  // Stable identities so effects that depend on them don't re-run on every
  // render (e.g. Game.tsx's AI solve effect keyed on state.loading), and so
  // memoized <Tile/>s skip re-renders when only unrelated state changes.
  const toggleWord = useCallback(
    (word: string) => dispatch({ type: "TOGGLE_WORD", word }),
    [],
  );
  const submitGuess = useCallback(() => dispatch({ type: "SUBMIT_GUESS" }), []);
  const deselectAll = useCallback(() => dispatch({ type: "DESELECT_ALL" }), []);
  const clearFeedback = useCallback(
    () => dispatch({ type: "CLEAR_FEEDBACK" }),
    [],
  );
  const confirmSolve = useCallback(
    () => dispatch({ type: "CONFIRM_SOLVE" }),
    [],
  );
  const aiSolve = useCallback(() => dispatch({ type: "AI_SOLVE_START" }), []);
  const aiSolveSuccess = useCallback(
    (solution: AiSolveResponse) =>
      dispatch({ type: "AI_SOLVE_SUCCESS", payload: solution }),
    [],
  );
  const aiSolveError = useCallback(
    (error: string) => dispatch({ type: "AI_SOLVE_FAILURE", payload: error }),
    [],
  );
  // Recreated only when the board changes, so Shuffle always shuffles the
  // words the player currently sees.
  const shuffleBoard = useCallback(
    () => dispatch({ type: "SHUFFLE", words: shuffle(state.remainingWords) }),
    [state.remainingWords],
  );

  return {
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
  };
}
