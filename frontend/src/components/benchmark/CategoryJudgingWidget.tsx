import { useEffect, useState } from "react";
import { fetchCategoryEvaluationCoverage } from "../../data/benchmark/api";
import { formatAutomationLine } from "./automationFormat";
import type { AutomationLegDisplay, CategoryEvaluationCoverage } from "../../data/benchmark/types";

// Matches the Recent Activity feed's poll cadence — a judge dispatch drains
// the backlog over a minute or two, and this is the number that tells the
// viewer whether to dispatch more, so it needs to keep up without a manual
// refresh.
const COVERAGE_POLL_MS = 10_000;

const TITLE = "Category judging";

export interface CategoryJudgingWidgetProps {
  /** The daily-automation judge-dispatch leg — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

/** Activity-page card: how much of the LLM category-judge backlog is done
 * (see CategoryEvaluationCoverage). Self-fetches and polls so a running
 * `evaluate-categories` dispatch visibly drains it. `pending` is exactly
 * what the next dispatch would enqueue — the figure to size a dispatch by. */
export function CategoryJudgingWidget({ automation }: CategoryJudgingWidgetProps = {}) {
  const [coverage, setCoverage] = useState<CategoryEvaluationCoverage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const load = () => {
      fetchCategoryEvaluationCoverage(controller.signal)
        .then((next) => {
          if (cancelled) return;
          setCoverage(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to load judging coverage");
          }
        });
    };

    load();
    const intervalId = setInterval(load, COVERAGE_POLL_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(intervalId);
    };
  }, []);

  if (error) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{TITLE}</span>
        <p className="bench-error">Couldn&apos;t load judging coverage: {error}</p>
      </div>
    );
  }

  if (!coverage) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{TITLE}</span>
        <p className="bench-muted">Loading…</p>
      </div>
    );
  }

  const { eligible, judged, pending } = coverage;
  const percentJudged = eligible === 0 ? 0 : Math.min(100, (judged / eligible) * 100);
  const summary =
    eligible === 0
      ? "Nothing to judge yet"
      : pending === 0
        ? `All ${eligible.toLocaleString()} judged`
        : `${pending.toLocaleString()} to judge`;

  return (
    <div className="bench-free-tier" role="status" aria-label="Category judging coverage">
      <div className="bench-free-tier__head">
        <span className="bench-free-tier__title">{TITLE}</span>
        <span className="bench-mono bench-free-tier__figures">
          {judged.toLocaleString()} / {eligible.toLocaleString()} judged
        </span>
      </div>
      <div
        className="bench-free-tier__bar"
        role="progressbar"
        aria-valuenow={Math.round(percentJudged)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="bench-free-tier__bar-fill" style={{ width: `${percentJudged}%` }} />
      </div>
      <span className="bench-muted bench-free-tier__remaining">{summary}</span>
      {automation ? (
        <p className={automation.isError ? "bench-error" : "bench-muted"}>
          {formatAutomationLine(automation)}
        </p>
      ) : null}
    </div>
  );
}
