import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteErroredRuns,
  deleteFailedJudgeCalls,
  fetchErroredRunCount,
  fetchFailedJudgeCallCount,
} from "../../data/benchmark/api";
import { BulkActionModal } from "./BulkActionModal";

const ERRORED_RUN_COUNT_KEY = ["errored-run-count"];
const FAILED_JUDGE_CALL_COUNT_KEY = ["failed-judge-call-count"];

type OpenModal = null | "errored" | "failed";

/** Destructive bulk-cleanup controls, grouped on their own page so they're
 * out of the way of day-to-day dashboards. Two actions:
 *
 *  - Delete errored strategy runs — every run stuck in the 'error' status,
 *    plus all rows tied to each, so a batch that blew up on a since-fixed
 *    bug can be cleared and rerun.
 *  - Delete failed judge calls — every CategoryEvaluation with status
 *    'callError', so the next evaluate-categories dispatch re-judges those
 *    proposals instead of skipping over their failed attempt.
 *
 * Each shows its current count and is disabled at zero; the button opens a
 * password-gated confirm modal (BulkActionModal). */
export function MaintenancePanel() {
  const queryClient = useQueryClient();
  const [openModal, setOpenModal] = useState<OpenModal>(null);

  const erroredQuery = useQuery({
    queryKey: ERRORED_RUN_COUNT_KEY,
    queryFn: ({ signal }) => fetchErroredRunCount(signal),
  });
  const failedQuery = useQuery({
    queryKey: FAILED_JUDGE_CALL_COUNT_KEY,
    queryFn: ({ signal }) => fetchFailedJudgeCallCount(signal),
  });

  const erroredCount = erroredQuery.data?.erroredRuns;
  const failedCount = failedQuery.data?.failed;

  const refetchCounts = () => {
    void queryClient.invalidateQueries({ queryKey: ERRORED_RUN_COUNT_KEY });
    void queryClient.invalidateQueries({ queryKey: FAILED_JUDGE_CALL_COUNT_KEY });
  };

  return (
    <section className="bench-page__section" aria-label="Bulk cleanup">
      <div className="bench-page__section-head">
        <h2 className="bench-page__section-title">Bulk cleanup</h2>
      </div>

      <ul className="bench-maint-list">
        <li className="bench-maint-row">
          <div className="bench-maint-row__text">
            <span className="bench-maint-row__label">Errored strategy runs</span>
            <span className="bench-muted">
              Permanently delete every run in the <code>error</code> status, along with its
              guesses, solve prompts, LLM proposals, and category-judge verdicts. Rerun them
              afterwards from a clean slate.
            </span>
          </div>
          <span className="bench-mono bench-maint-row__count">
            {erroredCount === undefined ? "…" : erroredCount}
          </span>
          <button
            type="button"
            className="bench-btn-danger"
            disabled={!erroredCount}
            onClick={() => setOpenModal("errored")}
          >
            Delete errored runs
          </button>
        </li>

        <li className="bench-maint-row">
          <div className="bench-maint-row__text">
            <span className="bench-maint-row__label">Failed judge calls</span>
            <span className="bench-muted">
              Permanently delete every category-judge verdict whose call errored out
              (<code>callError</code>). The next judging dispatch re-judges those proposals
              instead of skipping past the failed attempt.
            </span>
          </div>
          <span className="bench-mono bench-maint-row__count">
            {failedCount === undefined ? "…" : failedCount}
          </span>
          <button
            type="button"
            className="bench-btn-danger"
            disabled={!failedCount}
            onClick={() => setOpenModal("failed")}
          >
            Delete failed judge calls
          </button>
        </li>
      </ul>

      {(erroredQuery.error || failedQuery.error) && (
        <p className="bench-error">Couldn&apos;t load one or more maintenance counts.</p>
      )}

      {openModal === "errored" && (
        <BulkActionModal
          title="Delete errored runs"
          warning={
            `This permanently deletes ${erroredCount ?? "all"} errored strategy run(s) and ` +
            "every row tied to them. This cannot be undone."
          }
          confirmLabel="Delete errored runs"
          action={deleteErroredRuns}
          onClose={() => setOpenModal(null)}
          onDone={refetchCounts}
        />
      )}

      {openModal === "failed" && (
        <BulkActionModal
          title="Delete failed judge calls"
          warning={
            `This permanently deletes ${failedCount ?? "all"} failed judge call(s). They will be ` +
            "re-judged on the next dispatch. This cannot be undone."
          }
          confirmLabel="Delete failed judge calls"
          action={deleteFailedJudgeCalls}
          onClose={() => setOpenModal(null)}
          onDone={refetchCounts}
        />
      )}
    </section>
  );
}
