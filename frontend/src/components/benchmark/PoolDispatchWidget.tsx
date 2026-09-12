import { useState } from "react";
import { fetchPoolDispatchStatus, stopPoolDispatch } from "../../data/benchmark/api";
import type { AutomationLegDisplay } from "../../data/benchmark/types";
import type { ProviderPool } from "../../data/benchmark/providerPools";
import { formatAutomationLine } from "./automationFormat";
import { useResource } from "../../hooks/useResource";
import { StatusPill } from "./StatusPill";

// Matches FreeTierBudgetWidget's own dispatch-status poll cadence.
const DISPATCH_STATUS_POLL_MS = 30_000;

export interface PoolDispatchWidgetProps {
  /** The provider pool this widget dispatches — drives the title, which
   * endpoint it polls, and (only for the one account-budget pool,
   * openrouter) the calls/budget line. */
  pool: ProviderPool;
  /** The daily-automation burn leg for this pool — see AutomationStatus. */
  automation?: AutomationLegDisplay | null;
}

/** Activity-page widget: whether `pool`'s free-daily-quota dispatch cycle
 * (the backend's unified FreeDispatchService) is currently running, plus
 * (via `automation`) when the daily-automation chain last tried to start it
 * and when it will try again. Replaces the five near-identical
 * <Provider>DispatchWidget components — the only real per-pool difference
 * was the calls/budget line, which the status payload itself now carries
 * (callsToday/dailyBudget present only for the account-budget pool). */
export function PoolDispatchWidget({ pool, automation }: PoolDispatchWidgetProps) {
  const [isDisabling, setIsDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  const title = `${pool.label} daily quota`;

  const { data: status, error, refetch: refetchStatus } = useResource(
    ["poolDispatchStatus", pool.id],
    (signal) => fetchPoolDispatchStatus(pool.id, signal),
    { keepPreviousData: true, refetchInterval: DISPATCH_STATUS_POLL_MS },
  );

  function handleDisable() {
    setIsDisabling(true);
    setDisableError(null);

    stopPoolDispatch(pool.id)
      .then(() => refetchStatus())
      .catch((err: unknown) => {
        setDisableError(err instanceof Error ? err.message : "Failed to disable auto-dispatch");
      })
      .finally(() => setIsDisabling(false));
  }

  if (error) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{title}</span>
        <p className="bench-error">
          Couldn&apos;t load {pool.label} dispatch status: {error.message}
        </p>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{title}</span>
        <p className="bench-muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="bench-free-tier" role="status" aria-label={`${title} dispatch`}>
      <div className="bench-free-tier__head">
        <span className="bench-free-tier__title">{title}</span>
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
      {status.dailyBudget !== undefined ? (
        <span className="bench-muted">
          {status.callsToday} / {status.dailyBudget} calls today
        </span>
      ) : null}
      {disableError ? <p className="bench-error">{disableError}</p> : null}
      {automation ? (
        <p className={automation.isError ? "bench-error" : "bench-muted"}>
          {formatAutomationLine(automation)}
        </p>
      ) : null}
    </div>
  );
}
