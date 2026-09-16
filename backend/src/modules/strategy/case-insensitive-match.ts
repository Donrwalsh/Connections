function normalizeForComparison(word: string): string {
  return word.trim().toLowerCase();
}

/**
 * Whether `guessWords` is one of `answerGroups`, ignoring case — but not
 * ignoring it vacuously: an exact-case match returns null too, since that's
 * not a mismatch and the caller already has its own path for it. Word order
 * within the guess doesn't matter (the puzzle doesn't expose a canonical
 * order either). Returns the matching group's own canonical-case words so
 * the caller can normalize the proposal to them.
 */
export function findCaseInsensitiveGroupMatch(
  guessWords: string[],
  answerGroups: string[][],
): string[] | null {
  const sortedLowerGuess = guessWords.map(normalizeForComparison).sort();
  const sortedTrimmedGuess = guessWords.map((w) => w.trim()).sort();

  for (const group of answerGroups) {
    if (group.length !== guessWords.length) continue;

    const sortedLowerGroup = group.map(normalizeForComparison).sort();
    const isCaseInsensitiveMatch = sortedLowerGuess.every((w, i) => w === sortedLowerGroup[i]);
    if (!isCaseInsensitiveMatch) continue;

    const sortedGroup = [...group].sort();
    const isExactMatch = sortedTrimmedGuess.every((w, i) => w === sortedGroup[i]);
    if (isExactMatch) continue;

    return group;
  }

  return null;
}
