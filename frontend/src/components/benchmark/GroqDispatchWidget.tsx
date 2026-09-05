import { useEffect, useState } from "react";
import { fetchGroqDispatchStatus, stopGroqDispatch } from "../../data/benchmark/api";
import type { AutomationLegDisplay, GroqDispatchStatus } from "../../data/benchmark/types";
import { formatAutomationLine } from "./automationFormat";
import { StatusPill } from "./StatusPill";

// Matches FreeTierBudgetWidget's own dispatch-status poll cadence.
const DISPATCH_STATUS_POLL_MS = 30_000;

const TITLE = "Groq daily quota";

export interface GroqDispatchWidgetProps {
  /** The daily-automation Groq-burn leg — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

/** Activity-page widget: whether the Groq free-daily-quota dispatch cycle
 * (GroqFreeDispatchService) is currently running, plus (via `automation`)
 * when the daily-automation chain last tried to start it and when it will
 * try again. Unlike the OpenAI tiers there's no token budget to show a
 * progress bar against — Groq's constraint is a per-model per-day request
 * cap enforced by Groq itself, so this only ever shows active/inactive. */
export function GroqDispatchWidget({ automation }: GroqDispatchWidgetProps = {}) {
  const [status, setStatus] = useState<GroqDispatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDisabling, setIsDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      fetchGroqDispatchStatus(controller.signal)
        .then((next) => {
          setStatus(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to load Groq dispatch status");
        });
    };

    poll();
    const intervalId = setInterval(poll, DISPATCH_STATUS_POLL_MS);

    return () => {
      controller.abort();
      clearInterval(intervalId);
    };
  }, []);

  function handleDisable() {
    setIsDisabling(true);
    setDisableError(null);

    stopGroqDispatch()
      .then(() => fetchGroqDispatchStatus())
      .then(setStatus)
      .catch((err: unknown) => {
        setDisableError(err instanceof Error ? err.message : "Failed to disable auto-dispatch");
      })
      .finally(() => setIsDisabling(false));
  }

  if (error) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{TITLE}</span>
        <p className="bench-error">Couldn&apos;t load Groq dispatch status: {error}</p>
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
    <div className="bench-free-tier" role="status" aria-label="Groq daily quota dispatch">
      <div className="bench-free-tier__head">
        <span className="bench-free-tier__title">{TITLE}</span>
        {status.active ? (
          <>
            <StatusPill label="Auto-dispatch active" tone="active" />
            <button
              type="button"
              className="bench-sort-btn"
              onClick={handleDisable}
              disabled={isDisabling}
            >
              {isDisabling ? "Disabling…" : "Disable"}
            </button>
          </>
        ) : null}
      </div>
      <span className="bench-muted">
        {status.active ? "Dispatching trials against unrun puzzles." : "Not currently dispatching."}
      </span>
      {disableError ? <p className="bench-error">{disableError}</p> : null}
      {automation ? (
        <p className={automation.isError ? "bench-error" : "bench-muted"}>
          {formatAutomationLine(automation)}
        </p>
      ) : null}
    </div>
  );
}
