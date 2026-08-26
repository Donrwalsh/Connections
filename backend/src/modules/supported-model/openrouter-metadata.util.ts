// Best-effort parameter-count extraction — OpenRouter has no structured
// field for this. Tries the slug/name first (e.g. "8b" in
// "llama-3.1-8b-instruct"), then falls back to description prose (e.g.
// "7.3B parameter model"). Returns null when neither matches; expected for
// most OpenAI rows, since OpenAI doesn't publish parameter counts at all.
const SLUG_PARAM_RE = /(\d+(?:\.\d+)?)b(?:[-_]|$)/i;
const DESCRIPTION_PARAM_RE = /(\d+(?:\.\d+)?)\s*b(?:illion)?\s*param/i;

export function parseParamCount(slugOrText: string): number | null {
  const slugMatch = SLUG_PARAM_RE.exec(slugOrText);
  if (slugMatch) return Math.round(parseFloat(slugMatch[1]) * 1_000_000_000);

  const descriptionMatch = DESCRIPTION_PARAM_RE.exec(slugOrText);
  if (descriptionMatch) return Math.round(parseFloat(descriptionMatch[1]) * 1_000_000_000);

  return null;
}

/** OpenRouter's `created` field is Unix seconds, not milliseconds. */
export function parseReleaseDate(createdUnixSeconds: number): Date {
  return new Date(createdUnixSeconds * 1000);
}
