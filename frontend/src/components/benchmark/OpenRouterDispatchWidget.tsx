import { useEffect, useState } from "react";
import {
  fetchOpenRouterDispatchStatus,
  stopOpenRouterDispatch,
} from "../../data/benchmark/api";
import type { AutomationLegDisplay, OpenRouterDispatchStatus } from "../../data/benchmark/types";
import { formatAutomationLine } from "./automationFormat";
import { StatusPill } from "./StatusPill";

// Matches FreeTierBudgetWidget's own dispatch-status poll cadence.
const DISPATCH_STATUS_POLL_MS = 30_000;

const TITLE = "OpenRouter daily quota";

export interface OpenRouterDispatchWidgetProps {
  /** The daily-automation OpenRouter-burn leg — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

/** Activity-page widget: whether the OpenRouter free-daily-budget dispatch
 * cycle (OpenRouterFreeDispatchService) is currently running, plus (via
 * `automation`) when the daily-automation chain last tried to start it and
 * when it will try again. Unlike Groq/Google, OpenRouter's free tier caps
 * *total* requests across all :free models, so there is a single
 * account-wide "calls today / budget" number worth surfacing. */
export function OpenRouterDispatchWidget({ automation }: OpenRouterDispatchWidgetProps = {}) {
  const [status, setStatus] = useState<OpenRouterDispatchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDisabling, setIsDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      fetchOpenRouterDispatchStatus(controller.signal)
        .then((next) => {
          setStatus(next);
          setError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof Error && err.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "Failed to load OpenRouter dispatch status");
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

    stopOpenRouterDispatch()
      .then(() => fetchOpenRouterDispatchStatus())
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
        <p className="bench-error">Couldn&apos;t load OpenRouter dispatch status: {error}</p>
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
    <div className="bench-free-tier" role="status" aria-label="OpenRouter daily quota dispatch">
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
      <span className="bench-muted">
        {status.callsToday} / {status.dailyBudget} calls today
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
