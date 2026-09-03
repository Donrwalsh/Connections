import { MaintenancePanel } from "../../components/benchmark/MaintenancePanel";

/** Destructive bulk-cleanup actions, kept on their own route so they're
 * away from the day-to-day dashboards: clear out errored strategy runs, and
 * clear out failed category-judge calls so they get re-judged. */
export function MaintenancePage() {
  return (
    <div className="bench-page">
      <header className="bench-page-header">
        <div className="bench-page-header__title-block">
          <h1 className="bench-page-header__title">Maintenance</h1>
          <p className="bench-strategy-desc">
            One-shot cleanup for data left behind by since-fixed bugs. Every action here is
            permanent.
          </p>
        </div>
      </header>

      <MaintenancePanel />
    </div>
  );
}
