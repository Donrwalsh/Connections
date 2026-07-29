import type { Category, Difficulty } from "../data/samplePuzzle";

export type Feedback = "one-away" | "incorrect" | null;

export interface GameState {
  categories: Category[];
  remainingWords: string[];
  selected: string[];
  solved: Category[];
  mistakes: number;
  status: "playing" | "won" | "lost";
  feedback: Feedback;
  shakeWords: string[];
  pendingSolve: Category | null;
  guessHistory: Difficulty[][];
  //AI solve stuff:
  loading: boolean;
  error: string | null;
  ai_solution: Record<string, any> | null;
}

// 1. Define the nested proposed group shape
export interface ProposedGroup {
  words: string[];
  category: string;
  confidence: number;
  reasoning: string;
}

// 2. Define the inner 'data' payload
export interface AiSolveData {
  proposedGroup: ProposedGroup;
}

// 3. Define the full API Response payload
export interface AiSolveResponse {
  orchestrator: string;
  data: AiSolveData;
}

export type GameAction =
  | { type: "TOGGLE_WORD"; word: string }
  | { type: "SUBMIT_GUESS" }
  | { type: "DESELECT_ALL" }
  | { type: "CLEAR_FEEDBACK" }
  | { type: "AI_SOLVE_START" }
  | { type: "AI_SOLVE_SUCCESS"; payload: AiSolveResponse }
  | { type: "AI_SOLVE_FAILURE"; payload: string }
  | { type: "SHUFFLE"; words: string[] }
  | { type: "CONFIRM_SOLVE" };

const MAX_SELECTED = 4;
const MAX_MISTAKES = 4;

export function initGameState(
  categories: Category[],
  remainingWords: string[],
): GameState {
  return {
    categories,
    remainingWords,
    selected: [],
    solved: [],
    mistakes: 0,
    status: "playing",
    feedback: null,
    shakeWords: [],
    pendingSolve: null,
    guessHistory: [],
    loading: false,
    error: null,
    ai_solution: null,
  };
}

// Pure helper — given the current selection, find the category it fully
// matches, if any. Lives outside the reducer so it's independently testable.
function findMatchingCategory(
  categories: Category[],
  selected: string[],
): Category | undefined {
  return categories.find(
    (cat) =>
      cat.words.length === selected.length &&
      cat.words.every((w) => selected.includes(w)),
  );
}

// For a wrong guess, finds the highest number of selected words that belong
// to any single category. Used to detect "one away" (max overlap === 3).
function largestCategoryOverlap(
  categories: Category[],
  selected: string[],
): number {
  return categories.reduce((max, cat) => {
    const overlap = cat.words.filter((w) => selected.includes(w)).length;
    return Math.max(max, overlap);
  }, 0);
}

// Maps each selected word to the difficulty of the category it belongs to.
// Used to build a guess-history row for the emoji share grid — a correct
// guess is 4 of the same color, a wrong guess is a mix.
function difficultiesForGuess(
  categories: Category[],
  selected: string[],
): Difficulty[] {
  return selected.map((word) => {
    const owner = categories.find((cat) => cat.words.includes(word));
    // Every word belongs to exactly one category by construction of the
    // puzzle data, so this fallback should be unreachable in practice.
    return owner?.difficulty ?? "yellow";
  });
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "TOGGLE_WORD": {
      if (state.status !== "playing") return state;

      const { word } = action;
      const alreadySelected = state.selected.includes(word);

      if (alreadySelected) {
        return { ...state, selected: state.selected.filter((w) => w !== word) };
      }
      if (state.selected.length >= MAX_SELECTED) {
        return state;
      }
      return { ...state, selected: [...state.selected, word] };
    }

    case "SUBMIT_GUESS": {
      if (
        state.status !== "playing" ||
        state.selected.length !== MAX_SELECTED ||
        state.pendingSolve !== null
      ) {
        return state;
      }

      const match = findMatchingCategory(state.categories, state.selected);

      if (match) {
        return {
          ...state,
          pendingSolve: match,
          feedback: null,
          shakeWords: [],
          guessHistory: [
            ...state.guessHistory,
            difficultiesForGuess(state.categories, state.selected),
          ],
        };
      }

      // Wrong guess — capture which words to shake before clearing
      // selection, since selected is about to become [].
      const mistakes = state.mistakes + 1;
      const overlap = largestCategoryOverlap(state.categories, state.selected);

      return {
        ...state,
        mistakes,
        shakeWords: state.selected,
        selected: [],
        status: mistakes >= MAX_MISTAKES ? "lost" : "playing",
        feedback: overlap === 3 ? "one-away" : "incorrect",
        guessHistory: [
          ...state.guessHistory,
          difficultiesForGuess(state.categories, state.selected),
        ],
      };
    }

    case "AI_SOLVE_START":
      return { ...state, loading: true, error: null };
    case "AI_SOLVE_SUCCESS":
      console.log("Action Payload in Reducer:", action.payload);
      return {
        ...state,
        loading: false,
        ai_solution: action.payload.data,
        error: null,
      };
    case "AI_SOLVE_FAILURE":
      return {
        ...state,
        loading: false,
        ai_solution: null,
        error: action.payload,
      };

    case "DESELECT_ALL":
      return { ...state, selected: [] };

    case "CLEAR_FEEDBACK":
      return { ...state, feedback: null, shakeWords: [] };

    case "CONFIRM_SOLVE": {
      if (!state.pendingSolve) return state;

      const match = state.pendingSolve;
      const solved = [...state.solved, match];
      const remainingWords = state.remainingWords.filter(
        (w) => !match.words.includes(w),
      );
      const won = solved.length === state.categories.length;

      return {
        ...state,
        solved,
        remainingWords,
        selected: [],
        pendingSolve: null,
        status: won ? "won" : "playing",
      };
    }

    case "SHUFFLE":
      return { ...state, remainingWords: action.words };

    default:
      return state;
  }
}
