import { useState } from "react";
import {
  fetchFreeTierDispatchStatus,
  fetchFreeTierUsage,
  stopFreeTierDispatch,
} from "../../data/benchmark/api";
import { formatCostUsd } from "../../data/benchmark/metrics";
import { formatAutomationLine } from "./automationFormat";
import { useResource } from "../../hooks/useResource";
import type { FreeTierId, AutomationLegDisplay } from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

// Usage at or above this share of a tier's daily budget gets the warning
// tint on its bar, as an early heads-up before the budget is exhausted.
const WARNING_THRESHOLD_PERCENT = 90;

// How often to re-check whether a free-tier dispatch cycle is still
// running. The cycle can stop on its own (threshold reached, or it runs out
// of puzzles) between page loads, so a one-time fetch on mount would go
// stale — polling is what keeps "Auto-dispatch active" honest without the
// viewer having to refresh the page themselves.
const DISPATCH_STATUS_POLL_MS = 30_000;

// Frontend-owned copy for each tier's title, shown immediately (loading and
// error states included) rather than waiting on the fetched `label` field —
// same reasoning as StrategyMeta's static copy: which models a tier covers
// is backend truth (see FreeTierUsage.label/models), but the display title
// is UI copy this page controls directly.
const TIER_TITLES: Record<FreeTierId, string> = {
  flagship: "Flagship daily tokens",
  mini: "Mini & nano daily tokens",
};

export interface FreeTierBudgetWidgetProps {
  tier: FreeTierId;
  /** Total USD cost (summed from the leaderboard's per-model totalCostUsd,
   * across every trial ever run — not just today) of every trial run against
   * this tier's models. Unlike the token-budget figures below, this isn't a
   * daily figure and doesn't reset — it's real spend against the provider
   * bill, which the free-token budget only partially offsets. The parent
   * page owns this (it already loads the leaderboard the number comes from),
   * so it's a prop rather than something this widget fetches itself;
   * undefined/null just omits the line rather than showing $0.00 while it's
   * still loading. */
  spentUsd?: number | null;
  /** Bumped by the parent (e.g. after FreeTierDispatchModal starts a cycle
   * for this tier, or for 'both') to force an immediate dispatch-status
   * refetch instead of waiting up to DISPATCH_STATUS_POLL_MS — an action
   * taken elsewhere on the page that this widget wouldn't otherwise know
   * about. Not needed for this widget's own Disable button, which refetches
   * its own status directly after stopping. */
  refreshSignal?: number;
  /** The daily-automation "burn" leg for this tier (see AutomationStatus) —
   * only meaningful for the mini instance, which is the only tier the daily
   * automation chain touches; the flagship instance is simply never given
   * this prop by the parent. */
  automation?: AutomationLegDisplay | null;
}

/** Leaderboard widget: today's spend against one of the two free-token
 * programs (see FreeTierId) — the backend tracks a fixed model list and
 * daily limit per tier (FreeTierUsageService). Self-fetches so the rest of
 * the page doesn't wait on it; render one instance per tier. Also shows
 * whether a continuous dispatch cycle (FreeTierDispatchService) is
 * currently running for this tier and at what threshold, with a button to
 * disable it. */
export function FreeTierBudgetWidget({ tier, spentUsd, refreshSignal, automation }: FreeTierBudgetWidgetProps) {
  const { data: usage, error } = useResource(["freeTierUsage", tier], (signal) =>
    fetchFreeTierUsage(tier, signal),
  );
  const [isDisabling, setIsDisabling] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  // refreshSignal is folded into the key rather than read directly — a
  // sibling (FreeTierDispatchModal) bumps it to force an immediate re-poll
  // here instead of waiting up to DISPATCH_STATUS_POLL_MS. Best-effort: a
  // failed check just leaves the indicator showing whatever it last knew
  // (keepPreviousData), same as before.
  const { data: dispatchStatus, refetch: refetchDispatchStatus } = useResource(
    ["freeTierDispatchStatus", tier, refreshSignal],
    (signal) => fetchFreeTierDispatchStatus(tier, signal),
    { keepPreviousData: true, refetchInterval: DISPATCH_STATUS_POLL_MS },
  );

  function handleDisable() {
    setIsDisabling(true);
    setDisableError(null);

    stopFreeTierDispatch(tier)
      .then(() => refetchDispatchStatus())
      .catch((err: unknown) => {
        setDisableError(err instanceof Error ? err.message : "Failed to disable auto-dispatch");
      })
      .finally(() => setIsDisabling(false));
  }

  const title = TIER_TITLES[tier];

  if (error) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{title}</span>
        <p className="bench-error">Couldn&apos;t load token usage: {error.message}</p>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="bench-free-tier" role="status">
        <span className="bench-free-tier__title">{title}</span>
        <p className="bench-muted">Loading…</p>
      </div>
    );
  }

  const percentUsed =
    usage.dailyLimitTokens === 0
      ? 0
      : Math.min(100, (usage.usedTokens / usage.dailyLimitTokens) * 100);
  const isNearLimit = percentUsed >= WARNING_THRESHOLD_PERCENT;

  return (
    <div className="bench-free-tier" role="status" aria-label={`${title} usage`}>
      <div className="bench-free-tier__head">
        <span className="bench-free-tier__title">{title}</span>
        <span
          className="bench-mono bench-free-tier__figures"
          title={`Covers: ${usage.models.join(", ")}`}
        >
          {usage.usedTokens.toLocaleString()} / {usage.dailyLimitTokens.toLocaleString()} used
        </span>
      </div>
      {/* Always rendered (reserves a fixed row height via CSS) rather than
       * only when a cycle is active — otherwise the flagship and mini
       * widgets, which rarely have matching dispatch state at the same
       * time, end up different heights and everything below drifts out of
       * vertical alignment between the two side-by-side widgets. */}
      <div className="bench-free-tier__dispatch">
        {dispatchStatus?.active ? (
          <>
            <span
              title={
                `Auto-dispatch is queuing new ${tier}-tier trials, evenly spread across its models, ` +
                `until usage reaches ${dispatchStatus.thresholdPercent}% of the daily budget.`
              }
            >
              <StatusPill label={`Auto-dispatch active · ${dispatchStatus.thresholdPercent}%`} tone="active" />
            </span>
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
      {disableError ? <p className="bench-error">{disableError}</p> : null}
      <div
        className="bench-free-tier__bar"
        role="progressbar"
        aria-valuenow={Math.round(percentUsed)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`bench-free-tier__bar-fill${
            isNearLimit ? " bench-free-tier__bar-fill--warning" : ""
          }`}
          style={{ width: `${percentUsed}%` }}
        />
      </div>
      <span className="bench-muted bench-free-tier__remaining">
        {usage.remainingTokens.toLocaleString()} tokens remaining today
      </span>
      {automation ? (
        <p className={automation.isError ? "bench-error" : "bench-muted"}>
          {formatAutomationLine(automation)}
        </p>
      ) : null}
      {spentUsd !== undefined && spentUsd !== null ? (
        <span
          className="bench-muted bench-free-tier__spent"
          title="Total cost of every trial ever run against this tier's models, not just today's."
        >
          <span className="bench-mono">{formatCostUsd(spentUsd)}</span> spent on trials so far
        </span>
      ) : null}
    </div>
  );
}
