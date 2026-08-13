import type { PillTone } from "../../data/benchmark/runStatus";

export interface StatusPillProps {
  label: string;
  tone?: PillTone;
}

/** Small rounded status badge. Tone maps onto the app's accent/pill colors. */
export function StatusPill({ label, tone = "neutral" }: StatusPillProps) {
  const className = tone === "neutral" ? "bench-pill" : `bench-pill bench-pill--${tone}`;
  return <span className={className}>{label}</span>;
}
