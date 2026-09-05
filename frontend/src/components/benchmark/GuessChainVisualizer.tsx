import { useEffect, useState } from "react";
import { useAdminAuth } from "../../auth/useAdminAuth";
import { fetchRunDetail } from "../../data/benchmark/api";
import { formatDuration } from "../../data/benchmark/metrics";
import {
  categoryVerdictLabel,
  categoryVerdictTone,
  guessResultLabel,
  guessResultTone,
} from "../../data/benchmark/runStatus";
import type {
  DeleteRunResult,
  GuessRecord,
  LlmProposalRecord,
  SolvePromptRecord,
  StrategyRunDetail,
} from "../../data/benchmark/types";
import { DeleteRunModal } from "./DeleteRunModal";
import { StatusPill } from "./StatusPill";

export interface GuessChainVisualizerProps {
  runId: number;
  /** Called after the run is actually deleted (via the header's "Delete this
   * run" button, shown only for status 'error') — the parent page uses this
   * to refresh its own run list rather than leaving a stale, now-deleted run
   * in view. Optional: callers that don't offer deletion (none currently)
   * can omit it. */
  onDeleted?: (result: DeleteRunResult) => void;
}

/** Full detail for one run: for LLM strategies, the reconstructed
 * prompt -> candidate proposals -> guess outcome chain (solvePrompts is
 * populated); for everything else, a plain ordered guess list. Fetches its
 * own detail per runId so a multi-run picker can swap the visualized run
 * without the parent page owning the fetch/loading state. */
export function GuessChainVisualizer({ runId, onDeleted }: GuessChainVisualizerProps) {
  const { isAdmin } = useAdminAuth();
  const [detail, setDetail] = useState<StrategyRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    setDetail(null);

    const controller = new AbortController();
    fetchRunDetail(runId, controller.signal)
      .then((data) => {
        setDetail(data);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load run detail");
        setIsLoading(false);
      });

    return () => controller.abort();
  }, [runId]);

  return (
    <section className="bench-visualizer" aria-label={`Guess chain for run ${runId}`}>
      <div className="bench-visualizer__head">
        <div>
          <h2 className="bench-visualizer__title">Guess chain</h2>
          <p className="bench-mono bench-visualizer__runid">#{runId}</p>
        </div>
        {isAdmin && detail?.status === "error" ? (
          <button
            type="button"
            className="bench-sort-btn bench-sort-btn--danger"
            onClick={() => setShowDeleteModal(true)}
          >
            Delete this run
          </button>
        ) : null}
      </div>

      {isLoading ? <p className="bench-muted">Loading guess chain…</p> : null}
      {error && !isLoading ? <p className="bench-error">{error}</p> : null}

      {detail && !isLoading && !error ? (
        detail.solvePrompts.length > 0 ? (
          <PromptChain solvePrompts={detail.solvePrompts} />
        ) : (
          <PlainGuessList guesses={detail.guesses} />
        )
      ) : null}

      {showDeleteModal ? (
        <DeleteRunModal
          runId={runId}
          onClose={() => setShowDeleteModal(false)}
          onDeleted={(result) => onDeleted?.(result)}
        />
      ) : null}
    </section>
  );
}

/** The LLM guess chain: one step per model call, in order. */
function PromptChain({ solvePrompts }: { solvePrompts: SolvePromptRecord[] }) {
  return (
    <ol className="bench-chain">
      {solvePrompts.map((prompt) => (
        <li key={prompt.id} className="bench-chain__step">
          <PromptStep prompt={prompt} />
        </li>
      ))}
    </ol>
  );
}

function PromptStep({ prompt }: { prompt: SolvePromptRecord }) {
  const isCallError = prompt.status === "callError";
  const telemetry = [
    prompt.totalTokens !== null ? `${prompt.totalTokens.toLocaleString()} tok` : null,
    prompt.latencyMs !== null ? formatDuration(prompt.latencyMs) : null,
  ].filter(Boolean);

  return (
    <div className="bench-step">
      <div className="bench-step__head">
        <span className="bench-mono bench-step__number">#{prompt.promptNumber}</span>
        <span className="bench-step__type">
          {prompt.promptType === "retry" ? "Retry" : "Initial solve"}
        </span>
        {prompt.status !== "parsed" ? (
          <StatusPill label={solvePromptStatusLabel(prompt.status)} tone="failed" />
        ) : null}
        {prompt.issueTags.map((tag) => (
          <span key={tag} title={issueTagTitle(tag)}>
            <StatusPill label={issueTagLabel(tag)} tone="neutral" />
          </span>
        ))}
        {telemetry.length > 0 ? (
          <span className="bench-mono bench-step__telemetry">{telemetry.join(" · ")}</span>
        ) : null}
      </div>

      {prompt.reconstructedPrompt ? (
        <details className="bench-step__detail">
          <summary>
            Prompt sent to the model
            {prompt.promptTokens !== null ? ` (${prompt.promptTokens.toLocaleString()} tokens)` : ""}
          </summary>
          {/* The full chat payload as sent — every earlier step's prompt and
           * response plus this step's own new prompt, not just this step in
           * isolation (the runner sends the whole conversation each call). */}
          <pre className="bench-step__pre">{prompt.reconstructedPrompt}</pre>
        </details>
      ) : null}

      {prompt.rawResponseText ? (
        <details className="bench-step__detail">
          <summary>
            Raw response
            {prompt.completionTokens !== null
              ? ` (${prompt.completionTokens.toLocaleString()} tokens)`
              : ""}
          </summary>
          <pre className="bench-step__pre">{prompt.rawResponseText}</pre>
        </details>
      ) : null}

      {isCallError ? (
        <CallErrorDetail prompt={prompt} />
      ) : (
        <ul className="bench-proposals">
          {prompt.proposals.map((proposal) => (
            <ProposalRow key={proposal.id} proposal={proposal} />
          ))}
          {prompt.proposals.length === 0 ? (
            <li className="bench-muted bench-proposals__empty">No candidate groups parsed.</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

/** The OpenAI call itself failed — no model text at all, so there's nothing
 * to show in the usual proposals list. Surfaces the error message/status
 * plus the raw request/response the orchestrator captured, in the same
 * collapsible-detail style as the prompt/response blocks above. */
function CallErrorDetail({ prompt }: { prompt: SolvePromptRecord }) {
  const summary = [
    prompt.errorName,
    prompt.statusCode !== null ? `HTTP ${prompt.statusCode}` : null,
    prompt.isRetryable !== null ? (prompt.isRetryable ? "retryable" : "not retryable") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="bench-call-error">
      <p className="bench-call-error__message">
        {prompt.errorMessage ?? "The call failed with no further detail recorded."}
      </p>
      {summary ? <p className="bench-mono bench-muted">{summary}</p> : null}

      {prompt.requestBody !== null ? (
        <details className="bench-step__detail">
          <summary>Raw request sent to OpenAI</summary>
          <pre className="bench-step__pre">{JSON.stringify(prompt.requestBody, null, 2)}</pre>
        </details>
      ) : null}

      {prompt.responseBody !== null ? (
        <details className="bench-step__detail">
          <summary>Raw response from OpenAI</summary>
          <pre className="bench-step__pre">{JSON.stringify(prompt.responseBody, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** One candidate group. The proposal actually submitted as a guess ("used")
 * gets the accent-border "selected" treatment per DESIGN.md; every other
 * suggestion is included but rendered muted, with no outcome pill since it
 * was never submitted. */
function ProposalRow({ proposal }: { proposal: LlmProposalRecord }) {
  const isUsed = proposal.status === "used";
  return (
    <li
      className={`bench-proposal${isUsed ? " bench-proposal--used" : " bench-proposal--unused"}`}
    >
      <span className="bench-proposal__category">{proposal.category}</span>
      <span className="bench-mono bench-proposal__words">{proposal.words.join(", ")}</span>
      {proposal.guess ? (
        <StatusPill
          label={guessResultLabel(proposal.guess.result)}
          tone={guessResultTone(proposal.guess.result)}
        />
      ) : (
        <span className="bench-proposal__unused-label">Not submitted</span>
      )}
      {proposal.categoryEvaluation ? (
        <>
          <StatusPill
            label={categoryVerdictLabel(proposal.categoryEvaluation.verdict)}
            tone={categoryVerdictTone(proposal.categoryEvaluation.verdict)}
          />
          <details className="bench-step__detail">
            <summary>Category judge</summary>
            <div className="bench-proposal__judge">
              <p><strong>Proposed:</strong> {proposal.categoryEvaluation.proposedCategory}</p>
              <p><strong>Actual:</strong> {proposal.categoryEvaluation.actualCategory}</p>
              {proposal.categoryEvaluation.rationale ? (
                <p>{proposal.categoryEvaluation.rationale}</p>
              ) : null}
              <p className="bench-mono bench-muted">
                {[
                  `${proposal.categoryEvaluation.judgeProvider}/${proposal.categoryEvaluation.judgeModel}`,
                  proposal.categoryEvaluation.totalTokens !== null
                    ? `${proposal.categoryEvaluation.totalTokens} tok`
                    : null,
                  proposal.categoryEvaluation.latencyMs !== null
                    ? formatDuration(proposal.categoryEvaluation.latencyMs)
                    : null,
                  proposal.categoryEvaluation.statusCode !== null
                    ? `HTTP ${proposal.categoryEvaluation.statusCode}`
                    : null,
                ].filter(Boolean).join(" · ")}
              </p>
              {proposal.categoryEvaluation.errorMessage ? (
                <p className="bench-error">
                  {proposal.categoryEvaluation.errorName}: {proposal.categoryEvaluation.errorMessage}
                </p>
              ) : null}
              {proposal.categoryEvaluation.requestBody !== null ? (
                <details className="bench-step__detail">
                  <summary>Judge request</summary>
                  <pre className="bench-step__pre">
                    {JSON.stringify(proposal.categoryEvaluation.requestBody, null, 2)}
                  </pre>
                </details>
              ) : null}
              {proposal.categoryEvaluation.responseHeaders !== null ? (
                <details className="bench-step__detail">
                  <summary>Judge response headers</summary>
                  <pre className="bench-step__pre">
                    {JSON.stringify(proposal.categoryEvaluation.responseHeaders, null, 2)}
                  </pre>
                </details>
              ) : null}
              {proposal.categoryEvaluation.responseBody !== null ? (
                <details className="bench-step__detail">
                  <summary>Judge response body</summary>
                  <pre className="bench-step__pre">
                    {JSON.stringify(proposal.categoryEvaluation.responseBody, null, 2)}
                  </pre>
                </details>
              ) : null}
              {proposal.categoryEvaluation.rawResponseText ? (
                <details className="bench-step__detail">
                  <summary>Judge raw output</summary>
                  <pre className="bench-step__pre">{proposal.categoryEvaluation.rawResponseText}</pre>
                </details>
              ) : null}
            </div>
          </details>
        </>
      ) : null}
    </li>
  );
}

/** Fallback for strategies with no LLM solve-prompt chain (deterministic,
 * shuffle) — just the ordered guesses. */
function PlainGuessList({ guesses }: { guesses: GuessRecord[] }) {
  if (guesses.length === 0) {
    return <p className="bench-muted">No guesses recorded for this run.</p>;
  }
  return (
    <ol className="bench-guess-list">
      {guesses.map((guess) => (
        <li key={guess.sequenceNumber} className="bench-guess-list__item">
          <span className="bench-mono">#{guess.sequenceNumber}</span>
          <span className="bench-mono bench-guess-list__words">{guess.words.join(", ")}</span>
          <StatusPill label={guessResultLabel(guess.result)} tone={guessResultTone(guess.result)} />
        </li>
      ))}
    </ol>
  );
}

function solvePromptStatusLabel(status: SolvePromptRecord["status"]): string {
  switch (status) {
    case "malformedNoAnswerBlock":
      return "No answer block";
    case "callError":
      return "Call failed";
    case "parsed":
      return "Parsed";
  }
}

function issueTagLabel(tag: string): string {
  switch (tag) {
    case "parentheticalStripped":
      return "Parenthetical stripped";
    case "groupCountOff":
      return "Bad group count";
    case "wordNotOnList":
      return "Hallucinated word";
    case "unclassified":
      return "Unclassified issue";
    default:
      return tag;
  }
}

function issueTagTitle(tag: string): string {
  switch (tag) {
    case "parentheticalStripped":
      return "This response tucked an explanation into the Words: line — the parser stripped it before guessing.";
    case "groupCountOff":
      return "A group's Words: line didn't split into exactly 4 words.";
    case "wordNotOnList":
      return "The model proposed a word that was never part of this puzzle.";
    case "unclassified":
      return "A group went missing from the response for a reason not yet covered by a named check.";
    default:
      return "Unrecognized issue tag.";
  }
}
