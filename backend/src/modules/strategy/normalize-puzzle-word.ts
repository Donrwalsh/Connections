import { Puzzle } from "../game/entities/puzzle.entity";
import { StrategyRun } from "./entities/strategy-run.entity";

/**
 * One-off fixups for individual puzzle words whose literal text breaks the
 * LLM solve flow. The prompt lists items comma-joined and every downstream
 * parser (parse-groups-section.ts) splits the model's "Words:" line on
 * commas, so a word that itself contains a comma is impossible to round-trip
 * — the model echoes it verbatim and the split yields the wrong token count,
 * silently dropping the whole group.
 *
 * The only such word in the entire puzzle cache is "20,000" in the
 * 2023-09-11 puzzle. Mapping it to "20000" for the LLM path costs nothing
 * (the model still reads it as "twenty thousand") and makes the round-trip
 * unambiguous. Keyed by exact match so it can never touch any other word.
 */
const ONE_OFF_WORD_MAP: Readonly<Record<string, string>> = {
  "20,000": "20000",
};

export function normalizePuzzleWord(word: string): string {
  return ONE_OFF_WORD_MAP[word] ?? word;
}

/**
 * Applies normalizePuzzleWord in place to every word an LLM run touches:
 * the run's starting word order (which drives the prompt and the
 * "is this word still available" checks) and the loaded puzzle's answer
 * group members (which back both the hallucination check and
 * GameService.evaluateGuessOnPuzzle). After this, nothing in the LLM run
 * loop ever sees the comma form, so guesses the model returns still match.
 * Idempotent — safe to call again on a resumed run.
 */
export function applyOneOffWordFixups(run: StrategyRun, puzzle: Puzzle): void {
  run.availableWords = run.availableWords.map(normalizePuzzleWord);

  for (const group of puzzle.answerGroups) {
    for (const member of group.members) {
      member.word = normalizePuzzleWord(member.word);
    }
  }
}
