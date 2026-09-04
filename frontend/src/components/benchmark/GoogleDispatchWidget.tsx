import { useEffect, useState } from "react";
import { fetchGoogleDispatchStatus } from "../../data/benchmark/api";
import type { AutomationLegDisplay, GoogleDispatchStatus } from "../../data/benchmark/types";
import { formatAutomationLine } from "./automationFormat";
import { StatusPill } from "./StatusPill";

// Matches FreeTierBudgetWidget's own dispatch-status poll cadence.
const DISPATCH_STATUS_POLL_MS = 30_000;

const TITLE = "Google daily quota";

export interface GoogleDispatchWidgetProps {
  /** The daily-automation Google-burn leg — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

/** Activity-page widget: whether the Google free-daily-quota dispatch cycle
 * (GoogleFreeDispatchService) is currently running, plus (via `automation`)
 * when the daily-automation chain last tried to start it and when it will
 * try again. Unlike the OpenAI tiers there's no token budget to show a
 * progress bar against — Google's constraint is a per-day request cap
 * enforced by Google itself, so this only ever shows active/inactive. */
export function GoogleDispatchWidget({ automation }: GoogleDispatchWidgetProps = {}) {
  const [status, setStatus] = useState<GoogleDispatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      fetchGoogleDispatchStatus(controller.signal)
        .then((next) => {
          setStatus(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to load Google dispatch status");
        });
    };

    poll();
    const intervalId = setInterval(poll, DISPATCH_STATUS_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
  }, []);

  if (error) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{TITLE}</span>
        <p className="bench-error">Couldn&apos;t load Google dispatch status: {error}</p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{TITLE}</span>
        <p className="bench-muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="bench-free-tier" role="status" aria-label="Google daily quota dispatch">
      <div className="bench-free-tier__head">
        <span className="bench-free-tier__title">{TITLE}</span>
        {status.active ? <StatusPill label="Auto-dispatch active" tone="active" /> : null}
      </div>
      <span className="bench-muted">
        {status.active ? "Dispatching trials against unrun puzzles." : "Not currently dispatching."}
      </span>
      {automation ? (
        <p className={automation.isError ? "bench-error" : "bench-muted"}>
          {formatAutomationLine(automation)}
        </p>
      ) : null}
    </div>
  );
}
