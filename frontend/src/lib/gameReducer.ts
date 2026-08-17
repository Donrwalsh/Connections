import type { Category, Difficulty } from "../data/types";

export type Feedback = "one-away" | "incorrect" | null;

// Mirrors the orchestrator's GuessResult/PriorGuess schema
// (orchestrator/src/types.ts) — kept as a plain literal union here rather
// than importing across the frontend/orchestrator package boundary.
export type GuessResult = "correct" | "incorrect" | "oneAway";

export interface PriorGuess {
  words: string[];
  result: GuessResult;
}

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
  // Every submitted guess so far (correct, incorrect, or one-away), sent to
  // the orchestrator alongside remainingWords so it doesn't repeat a wrong
  // guess or ignore an already-solved group.
  priorGuesses: PriorGuess[];
  // AI Assist session state. `aiSession` carries the parts of the diagnostic
  // session the game state can't express: the message history fed to the LLM
  // (each press either starts a fresh INITIAL prompt or appends a RETRY prompt
  // onto it) and the last AI-proposed group that came back incorrect/one-away.
  // The session's locked-in groups and remaining items are the game state
  // itself (solved / remainingWords), since each AI guess is submitted through
  // the same validation the player uses.
  loading: boolean;
  error: string | null;
  ai_solution: AiAssistData | null;
  aiSession: AiSessionState;
}

// A single message in the AI Assist conversation history. The frontend builds
// the prompts from its session state, accumulates the model's raw responses,
// and submits the full history to the orchestrator on every button press.
export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

// The most recent AI-proposed group that came back "incorrect" or "oneAway".
// When set, the next button press appends a RETRY prompt to the history;
// otherwise it starts a fresh INITIAL prompt.
export interface AiLastFailedGuess {
  items: string[];
  result: GuessResult;
}

export interface AiSessionState {
  history: AiChatMessage[];
  lastFailedGuess: AiLastFailedGuess | null;
}

// 1. The inner 'data' payload returned by the backend's /api/diagnose proxy
// plus the echo the frontend adds (the exact prompt sent and the updated
// message history). Mirrors the orchestrator's assist response
// (orchestrator/src/types.ts).
export interface AiAssistData {
  response: string;
  groups: string[][];
  prompt: string;
  model?: string;
}

export interface AiAssistSuccessPayload extends AiAssistData {
  history: AiChatMessage[];
}

export type GameAction =
  | { type: "TOGGLE_WORD"; word: string }
  | { type: "SUBMIT_GUESS" }
  | { type: "DESELECT_ALL" }
  | { type: "CLEAR_FEEDBACK" }
  | { type: "AI_SOLVE_START" }
  | { type: "AI_SOLVE_SUCCESS"; payload: AiAssistSuccessPayload }
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
    priorGuesses: [],
    loading: false,
    error: null,
    ai_solution: null,
    aiSession: { history: [], lastFailedGuess: null },
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

// Runs a proposed group through the game's guess validation: does it exactly
// match a category, or is it a wrong guess (and if so, was it "one away")?
// Shared by the player's Submit button and the AI Assist flow so both get
// identical results.
function evaluateGuess(
  categories: Category[],
  words: string[],
): { kind: "correct"; category: Category } | { kind: "wrong"; result: GuessResult } {
  const match = findMatchingCategory(categories, words);
  if (match) {
    return { kind: "correct", category: match };
  }
  const overlap = largestCategoryOverlap(categories, words);
  return { kind: "wrong", result: overlap === 3 ? "oneAway" : "incorrect" };
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

      const outcome = evaluateGuess(state.categories, state.selected);

      if (outcome.kind === "correct") {
        return {
          ...state,
          pendingSolve: outcome.category,
          feedback: null,
          shakeWords: [],
          guessHistory: [
            ...state.guessHistory,
            difficultiesForGuess(state.categories, state.selected),
          ],
          priorGuesses: [
            ...state.priorGuesses,
            { words: state.selected, result: "correct" },
          ],
        };
      }

      // Wrong guess — capture which words to shake before clearing
      // selection, since selected is about to become [].
      const mistakes = state.mistakes + 1;

      return {
        ...state,
        mistakes,
        shakeWords: state.selected,
        selected: [],
        status: mistakes >= MAX_MISTAKES ? "lost" : "playing",
        feedback: outcome.result === "oneAway" ? "one-away" : "incorrect",
        guessHistory: [
          ...state.guessHistory,
          difficultiesForGuess(state.categories, state.selected),
        ],
        priorGuesses: [
          ...state.priorGuesses,
          { words: state.selected, result: outcome.result },
        ],
      };
    }

    case "AI_SOLVE_START":
      return { ...state, loading: true, error: null };

    // The LLM answered with a full set of proposed groups. Submit each group
    // through the same validation the player's Submit button uses, one at a
    // time in the order the model listed them:
    //   - correct: lock it in (solved / remainingWords), clear the last failed
    //     guess, and keep submitting the rest of the batch.
    //   - incorrect/one-away: record it as the last failed guess and stop —
    //     the remaining proposed groups are re-requested via the next RETRY
    //     prompt instead.
    // When every remaining group has been locked in the puzzle is solved and
    // the session state is cleared.
    case "AI_SOLVE_SUCCESS": {
      const { response, groups, prompt, model, history } = action.payload;

      const solved = [...state.solved];
      let remainingWords = [...state.remainingWords];
      let mistakes = state.mistakes;
      const guessHistory = [...state.guessHistory];
      const priorGuesses = [...state.priorGuesses];
      let lastFailedGuess: AiLastFailedGuess | null = null;
      let status = state.status;
      let feedback: Feedback = null;
      let shakeWords: string[] = [];

      for (const items of groups) {
        if (status !== "playing") break;

        const outcome = evaluateGuess(state.categories, items);

        if (outcome.kind === "correct") {
          const { category } = outcome;
          if (!solved.some((cat) => cat.id === category.id)) {
            solved.push(category);
            remainingWords = remainingWords.filter(
              (word) => !category.words.includes(word),
            );
          }
          lastFailedGuess = null;
          guessHistory.push(difficultiesForGuess(state.categories, items));
          priorGuesses.push({ words: items, result: "correct" });
          if (remainingWords.length === 0) {
            status = "won";
          }
          continue;
        }

        // Wrong guess — record it and stop submitting this batch.
        mistakes += 1;
        lastFailedGuess = { items, result: outcome.result };
        status = mistakes >= MAX_MISTAKES ? "lost" : "playing";
        feedback = outcome.result === "oneAway" ? "one-away" : "incorrect";
        shakeWords = items;
        guessHistory.push(difficultiesForGuess(state.categories, items));
        priorGuesses.push({ words: items, result: outcome.result });
        break;
      }

      const puzzleSolved = status === "won" || remainingWords.length === 0;

      return {
        ...state,
        loading: false,
        ai_solution: { response, groups, prompt, model },
        error: null,
        solved,
        remainingWords,
        mistakes,
        status,
        feedback,
        shakeWords,
        guessHistory,
        priorGuesses,
        aiSession: puzzleSolved
          ? { history: [], lastFailedGuess: null }
          : { history, lastFailedGuess },
      };
    }

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
