export interface VerdictSquaresProps {
  correct: number;
  partial: number;
  lucky: number;
}

const VERDICTS = [
  { key: "correct", tone: "correct", noun: "correct — judge matched the real connection" },
  { key: "partial", tone: "partial", noun: "partial — judge only partly matched the connection" },
  { key: "lucky", tone: "lucky", noun: "lucky — right four words, wrong connection" },
] as const;

/** Compact per-run tally of LLM category-judge verdicts: one small coloured
 * square per verdict kind that occurred, with its count inside. Zero-count
 * kinds are dropped, and the whole cluster renders nothing when a run has no
 * evaluations at all (deterministic runs, un-judged LLM runs) — so it costs
 * a run-history row nothing until there's something to show. Full detail is
 * on the run's guess chain. */
export function VerdictSquares({ correct, partial, lucky }: VerdictSquaresProps) {
  const counts = { correct, partial, lucky };
  const shown = VERDICTS.filter((verdict) => counts[verdict.key] > 0);
  if (shown.length === 0) return null;

  return (
    <span className="bench-verdicts" role="group" aria-label="Category-judge verdicts">
      {shown.map((verdict) => (
        <span
          key={verdict.key}
          className={`bench-verdict bench-verdict--${verdict.tone}`}
          title={`${counts[verdict.key]} ${verdict.noun}`}
        >
          {counts[verdict.key]}
        </span>
      ))}
    </span>
  );
}
