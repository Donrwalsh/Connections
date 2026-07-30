import { describe, it, expect } from "vitest";
import { gameReducer, initGameState } from "../gameReducer";
import type { Category } from "../../data/samplePuzzle";

// Sample test puzzle categories matching your Category type
const mockCategories: Category[] = [
  {
    id: "1",
    name: "FRUITS",
    difficulty: "yellow",
    words: ["APPLE", "BANANA", "CHERRY", "DATE"],
  },
  {
    id: "2",
    name: "COLORS",
    difficulty: "green",
    words: ["RED", "BLUE", "GREEN", "YELLOW"],
  },
  {
    id: "3",
    name: "ANIMALS",
    difficulty: "blue",
    words: ["DOG", "CAT", "BIRD", "FISH"],
  },
  {
    id: "4",
    name: "CITIES",
    difficulty: "purple",
    words: ["PARIS", "TOKYO", "LONDON", "ROME"],
  },
];

const allWords = mockCategories.flatMap((c) => c.words);

describe("gameReducer", () => {
  it("initializes game state properly with initGameState", () => {
    const state = initGameState(mockCategories, allWords);

    expect(state.categories).toEqual(mockCategories);
    expect(state.remainingWords).toEqual(allWords);
    expect(state.selected).toEqual([]);
    expect(state.solved).toEqual([]);
    expect(state.mistakes).toBe(0);
    expect(state.status).toBe("playing");
    expect(state.feedback).toBeNull();
  });

  describe("TOGGLE_WORD action", () => {
    it("selects an unselected word", () => {
      const initialState = initGameState(mockCategories, allWords);

      const nextState = gameReducer(initialState, {
        type: "TOGGLE_WORD",
        word: "APPLE",
      });

      expect(nextState.selected).toEqual(["APPLE"]);
    });

    it("deselects an already selected word", () => {
      const initialState = {
        ...initGameState(mockCategories, allWords),
        selected: ["APPLE", "BANANA"],
      };

      const nextState = gameReducer(initialState, {
        type: "TOGGLE_WORD",
        word: "APPLE",
      });

      expect(nextState.selected).toEqual(["BANANA"]);
    });

    it("prevents selecting more than 4 words", () => {
      const initialState = {
        ...initGameState(mockCategories, allWords),
        selected: ["APPLE", "BANANA", "CHERRY", "DATE"],
      };

      const nextState = gameReducer(initialState, {
        type: "TOGGLE_WORD",
        word: "RED",
      });

      expect(nextState.selected).toHaveLength(4);
      expect(nextState.selected).not.toContain("RED");
    });

    it("does not allow selection if status is not 'playing'", () => {
      const initialState = {
        ...initGameState(mockCategories, allWords),
        status: "lost" as const,
      };

      const nextState = gameReducer(initialState, {
        type: "TOGGLE_WORD",
        word: "APPLE",
      });

      expect(nextState.selected).toEqual([]);
    });
  });

  describe("SUBMIT_GUESS action", () => {
    it("handles a correct guess", () => {
      const initialState = {
        ...initGameState(mockCategories, allWords),
        selected: ["APPLE", "BANANA", "CHERRY", "DATE"],
      };

      const nextState = gameReducer(initialState, { type: "SUBMIT_GUESS" });

      expect(nextState.pendingSolve).toEqual(mockCategories[0]);
      expect(nextState.priorGuesses).toContainEqual({
        words: ["APPLE", "BANANA", "CHERRY", "DATE"],
        result: "correct",
      });
      expect(nextState.guessHistory).toHaveLength(1);
    });

    it("handles a 'one-away' incorrect guess", () => {
      // 3 fruits + 1 color
      const initialState = {
        ...initGameState(mockCategories, allWords),
        selected: ["APPLE", "BANANA", "CHERRY", "RED"],
      };

      const nextState = gameReducer(initialState, { type: "SUBMIT_GUESS" });

      expect(nextState.mistakes).toBe(1);
      expect(nextState.feedback).toBe("one-away");
      expect(nextState.selected).toEqual([]);
      expect(nextState.shakeWords).toEqual([
        "APPLE",
        "BANANA",
        "CHERRY",
        "RED",
      ]);
      expect(nextState.priorGuesses).toContainEqual({
        words: ["APPLE", "BANANA", "CHERRY", "RED"],
        result: "oneAway",
      });
    });

    it("triggers game over ('lost') on 4th mistake", () => {
      const initialState = {
        ...initGameState(mockCategories, allWords),
        selected: ["APPLE", "RED", "DOG", "PARIS"],
        mistakes: 3,
      };

      const nextState = gameReducer(initialState, { type: "SUBMIT_GUESS" });

      expect(nextState.mistakes).toBe(4);
      expect(nextState.status).toBe("lost");
      expect(nextState.feedback).toBe("incorrect");
    });
  });

  describe("CONFIRM_SOLVE action", () => {
    it("moves pending solve category into solved and removes words", () => {
      const fruitCategory = mockCategories[0];
      const initialState = {
        ...initGameState(mockCategories, allWords),
        pendingSolve: fruitCategory,
      };

      const nextState = gameReducer(initialState, { type: "CONFIRM_SOLVE" });

      expect(nextState.solved).toContain(fruitCategory);
      expect(nextState.pendingSolve).toBeNull();
      expect(nextState.remainingWords).not.toEqual(
        expect.arrayContaining(fruitCategory.words),
      );
    });

    it("transitions status to 'won' when all categories are solved", () => {
      const lastCategory = mockCategories[3];
      const initialState = {
        ...initGameState(mockCategories, allWords),
        solved: [mockCategories[0], mockCategories[1], mockCategories[2]],
        pendingSolve: lastCategory,
      };

      const nextState = gameReducer(initialState, { type: "CONFIRM_SOLVE" });

      expect(nextState.status).toBe("won");
      expect(nextState.solved).toHaveLength(4);
    });
  });

  describe("DESELECT_ALL and CLEAR_FEEDBACK actions", () => {
    it("clears selected words on DESELECT_ALL", () => {
      const initialState = {
        ...initGameState(mockCategories, allWords),
        selected: ["APPLE", "RED"],
      };

      const nextState = gameReducer(initialState, { type: "DESELECT_ALL" });

      expect(nextState.selected).toEqual([]);
    });

    it("resets feedback and shakeWords on CLEAR_FEEDBACK", () => {
      const initialState = {
        ...initGameState(mockCategories, allWords),
        feedback: "one-away" as const,
        shakeWords: ["APPLE", "BANANA", "CHERRY", "RED"],
      };

      const nextState = gameReducer(initialState, { type: "CLEAR_FEEDBACK" });

      expect(nextState.feedback).toBeNull();
      expect(nextState.shakeWords).toEqual([]);
    });
  });

  describe("AI_SOLVE actions", () => {
    it("sets loading to true on AI_SOLVE_START", () => {
      const initialState = initGameState(mockCategories, allWords);
      const nextState = gameReducer(initialState, { type: "AI_SOLVE_START" });

      expect(nextState.loading).toBe(true);
      expect(nextState.error).toBeNull();
    });

    it("updates ai_solution on AI_SOLVE_SUCCESS", () => {
      const initialState = {
        ...initGameState(mockCategories, allWords),
        loading: true,
      };

      const mockPayload = {
        orchestrator: "healthy" as const,
        data: {
          proposedGroup: {
            words: ["APPLE", "BANANA", "CHERRY", "DATE"],
            category: "FRUITS",
            confidence: 0.95,
            reasoning: "All are fruits",
          },
          prompt: "sample prompt",
        },
      };

      const nextState = gameReducer(initialState, {
        type: "AI_SOLVE_SUCCESS",
        payload: mockPayload,
      });

      expect(nextState.loading).toBe(false);
      expect(nextState.ai_solution).toEqual(mockPayload.data);
    });
  });
});
