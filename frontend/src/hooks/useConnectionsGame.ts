import { useReducer } from "react";
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

  return {
    state,
    toggleWord: (word: string) => dispatch({ type: "TOGGLE_WORD", word }),
    submitGuess: () => dispatch({ type: "SUBMIT_GUESS" }),
    deselectAll: () => dispatch({ type: "DESELECT_ALL" }),
    clearFeedback: () => dispatch({ type: "CLEAR_FEEDBACK" }),
    shuffleBoard: () =>
      dispatch({ type: "SHUFFLE", words: shuffle(state.remainingWords) }),
    aiSolve: () => dispatch({ type: "AI_SOLVE_START" }),
    aiSolveSuccess: (solution: AiSolveResponse) =>
      dispatch({ type: "AI_SOLVE_SUCCESS", payload: solution }),
    aiSolveError: (error: string) =>
      dispatch({ type: "AI_SOLVE_FAILURE", payload: error }),
    confirmSolve: () => dispatch({ type: "CONFIRM_SOLVE" }),
  };
}
