// strategies/combinatorics.ts

/**
 * Given a k-combination expressed as sorted indices into a pool of size n,
 * returns the next combination in lexicographic order, or null if this
 * was the last one.
 *
 * e.g. poolSize=5, k=4: [0,1,2,3] -> [0,1,2,4] -> [0,1,3,4] -> [0,2,3,4] -> [1,2,3,4] -> null
 */
export function nextCombination(
  indices: number[],
  poolSize: number,
): number[] | null {
  const k = indices.length;
  const next = [...indices];

  // Find the rightmost index that can still be incremented
  let i = k - 1;
  while (i >= 0 && next[i] === poolSize - k + i) {
    i--;
  }

  if (i < 0) return null; // exhausted every combination

  next[i]++;
  for (let j = i + 1; j < k; j++) {
    next[j] = next[j - 1] + 1;
  }

  return next;
}

export function combinationToWords(
  indices: number[],
  pool: string[],
): string[] {
  return indices.map((i) => pool[i]);
}

export function firstCombination(k: number): number[] {
  return Array.from({ length: k }, (_, i) => i);
}
