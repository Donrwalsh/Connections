import { useState } from "react";
import { fetchSambaNovaDispatchStatus, stopSambaNovaDispatch } from "../../data/benchmark/api";
import type { AutomationLegDisplay } from "../../data/benchmark/types";
import { formatAutomationLine } from "./automationFormat";
import { useResource } from "../../hooks/useResource";
import { StatusPill } from "./StatusPill";

// Matches FreeTierBudgetWidget's own dispatch-status poll cadence.
const DISPATCH_STATUS_POLL_MS = 30_000;

const TITLE = "SambaNova free tier";

export interface SambaNovaDispatchWidgetProps {
  /** The daily-automation SambaNova-burn leg — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

/** Activity-page widget: whether the SambaNova free-tier dispatch cycle
 * (SambaNovaFreeDispatchService) is currently running, plus (via
 * `automation`) when the daily-automation chain last tried to start it and
 * when it will try again. Unlike the OpenAI tiers there's no token budget to
 * show a progress bar against — SambaNova's per-model 20 rpm / 20 rpd / 200K
 * tpd caps are enforced by SambaNova itself, so this only ever shows
 * active/inactive. */
export function SambaNovaDispatchWidget({ automation }: SambaNovaDispatchWidgetProps = {}) {
  const [isDisabling, setIsDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  const { data: status, error, refetch: refetchStatus } = useResource(
    ["sambaNovaDispatchStatus"],
    (signal) => fetchSambaNovaDispatchStatus(signal),
    { keepPreviousData: true, refetchInterval: DISPATCH_STATUS_POLL_MS },
  );

  function handleDisable() {
    setIsDisabling(true);
    setDisableError(null);

    stopSambaNovaDispatch()
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
        <p className="bench-error">Couldn&apos;t load SambaNova dispatch status: {error.message}</p>
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
    <div className="bench-free-tier" role="status" aria-label="SambaNova free tier dispatch">
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
