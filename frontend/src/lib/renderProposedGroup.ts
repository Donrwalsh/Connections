/**
 * Renders a proposed AI group as JSON, injecting `// word` comments next to
 * each entry in `word_ids` so the player can see which word each index maps
 * to. JSON itself doesn't allow comments, but this is a read-only display,
 * and the comments make the recommendation legible.
 *
 * Falls back to plain JSON.stringify if the group's shape is unexpected.
 */
export function renderProposedGroup(
  proposedGroup: Record<string, unknown>,
  words: string[],
): string {
  if (!Array.isArray(proposedGroup.word_ids)) {
    return JSON.stringify(proposedGroup, null, 2);
  }

  const ids = proposedGroup.word_ids as number[];
  const entries = ids.map(
    (id, i) => `${id}${i < ids.length - 1 ? "," : ""}`,
  );
  const maxWidth = Math.max(0, ...entries.map((entry) => entry.length));

  const lines: string[] = ["{", '  "word_ids": ['];
  ids.forEach((id, i) => {
    const word = words[id];
    const comment = word ? `  // ${word}` : "";
    lines.push(`    ${entries[i].padEnd(maxWidth)}${comment}`);
  });

  lines.push("  ],");
  for (const key of Object.keys(proposedGroup)) {
    if (key === "word_ids") continue;
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(proposedGroup[key])}`);
  }
  lines.push("}");
  return lines.join("\n");
}
