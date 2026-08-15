/**
 * Renders the AI Assist diagnostic as readable JSON for the display pane.
 *
 * The diagnostic returns a full 4-group partition whose items are the board
 * words themselves (not word_ids), so no index resolution is needed — the
 * groups render as-is, with each group's items kept on a single line for
 * legibility. Falls back to plain JSON.stringify when the payload's shape is
 * unexpected.
 */

interface DiagnoseGroup {
  category: string;
  items: string[];
  confidence: number;
}

export function renderDiagnoseGroups(groups: unknown): string {
  if (!Array.isArray(groups)) {
    return JSON.stringify(groups, null, 2);
  }

  const malformed = groups.some(
    (group) =>
      !group ||
      typeof group !== "object" ||
      typeof (group as DiagnoseGroup).category !== "string" ||
      !Array.isArray((group as DiagnoseGroup).items) ||
      typeof (group as DiagnoseGroup).confidence !== "number",
  );
  if (malformed) {
    return JSON.stringify(groups, null, 2);
  }

  const rendered = (groups as DiagnoseGroup[]).map((group) => {
    return [
      "  {",
      `    "category": ${JSON.stringify(group.category)},`,
      `    "items": [${group.items.map((item) => JSON.stringify(item)).join(", ")}],`,
      `    "confidence": ${JSON.stringify(group.confidence)}`,
      "  }",
    ].join("\n");
  });

  return `[\n${rendered.join(",\n")}\n]`;
}
