const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });

const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
];

/** Compact relative label ("2m ago", "3h ago") for `iso` against `now`, with
 * no cutoff — counts up indefinitely rather than falling back to an absolute
 * date past some age. Callers supply `now` (rather than this function reading
 * Date.now() internally) so a single shared tick (see useRelativeNow) can
 * re-render every visible label in sync. Math.abs guards against a
 * slightly-future timestamp from clock skew producing a nonsensical negative
 * duration. */
export function formatRelativeTime(iso: string, now: number): string {
  const deltaMs = now - new Date(iso).getTime();
  const absDeltaMs = Math.abs(deltaMs);
  for (const { unit, ms } of UNITS) {
    if (absDeltaMs >= ms) {
      return rtf.format(Math.round(-deltaMs / ms), unit);
    }
  }
  return rtf.format(0, "second");
}
