import { useState } from "react";
import { fetchMistralDispatchStatus, stopMistralDispatch } from "../../data/benchmark/api";
import type { AutomationLegDisplay } from "../../data/benchmark/types";
import { formatAutomationLine } from "./automationFormat";
import { useResource } from "../../hooks/useResource";
import { StatusPill } from "./StatusPill";

// Matches FreeTierBudgetWidget's own dispatch-status poll cadence.
const DISPATCH_STATUS_POLL_MS = 30_000;

const TITLE = "Mistral free tier";

export interface MistralDispatchWidgetProps {
  /** The daily-automation Mistral-burn leg — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

/** Activity-page widget: whether the Mistral free-dispatch cycle
 * (MistralFreeDispatchService) is currently running, plus (via `automation`)
 * when the daily-automation chain last tried to start it and when it will
 * try again. Unlike the OpenAI tiers there's no token budget to show a
 * progress bar against — Mistral's constraints (a global 1 req/sec cap plus
 * per-pool tokens-per-minute and tokens-per-month limits) are enforced by
 * Mistral itself, so this only ever shows active/inactive. */
export function MistralDispatchWidget({ automation }: MistralDispatchWidgetProps = {}) {
  const [isDisabling, setIsDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  const { data: status, error, refetch: refetchStatus } = useResource(
    ["mistralDispatchStatus"],
    (signal) => fetchMistralDispatchStatus(signal),
    { keepPreviousData: true, refetchInterval: DISPATCH_STATUS_POLL_MS },
  );

  function handleDisable() {
    setIsDisabling(true);
    setDisableError(null);

    stopMistralDispatch()
      .then(() => refetchStatus())
      .catch((err: unknown) => {
        setDisableError(err instanceof Error ? err.message : "Failed to disable auto-dispatch");
      })
      .finally(() => setIsDisabling(false));
  }

  if (error) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{TITLE}</span>
        <p className="bench-error">Couldn&apos;t load Mistral dispatch status: {error.message}</p>
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
    <div className="bench-free-tier" role="status" aria-label="Mistral free tier dispatch">
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
