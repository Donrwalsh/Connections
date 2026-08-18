export type Difficulty = "yellow" | "green" | "blue" | "purple";

export interface Category {
  id: string;
  name: string;
  difficulty: Difficulty;
  words: string[];
}

export interface Puzzle {
  id: number;
  date: string;
  categories: Category[];
  wordOrder: string[];
}

// Flattens + shuffles the 16 words for initial board display.
// Simple Fisher-Yates — swap for a seeded shuffle later if you want
// deterministic "daily" board ordering.
// export function shuffleWords(categories: Category[]): string[] {
//   const words = categories.flatMap((c) => c.words);
//   for (let i = words.length - 1; i > 0; i--) {
//     const j = Math.floor(Math.random() * (i + 1));
//     [words[i], words[j]] = [words[j], words[i]];
//   }
//   return words;
export function shuffleWords(categories: Category[] = []) {
  if (!Array.isArray(categories)) {
    return [];
  }

  // Your existing flatMap logic
  const words = categories.flatMap((cat) => cat.words);

  // Return shuffled array...
  return words.sort(() => Math.random() - 0.5);
}
