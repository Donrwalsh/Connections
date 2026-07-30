export interface Category {
  id: string;
  name: string;
  difficulty: Difficulty;
  words: string[];
}

export interface Puzzle {
  date: string;
  categories: Category[];
}

export type Difficulty = "yellow" | "green" | "blue" | "purple";
