import type { Difficulty } from "../data/samplePuzzle";

const EMOJI_BY_DIFFICULTY: Record<Difficulty, string> = {
  yellow: "🟨",
  green: "🟩",
  blue: "🟦",
  purple: "🟪",
};

// Pure function, independently testable — turns guess history into the
// shareable emoji grid text, matching the real game's format.
export function buildShareText(
  guessHistory: Difficulty[][],
  puzzleDate: string,
): string {
  const rows = guessHistory
    .map((row) =>
      row.map((difficulty) => EMOJI_BY_DIFFICULTY[difficulty]).join(""),
    )
    .join("\n");

  return `Connections\n${puzzleDate}\n${rows}`;
}
