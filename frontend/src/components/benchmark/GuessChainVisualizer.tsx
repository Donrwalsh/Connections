import { useEffect, useState } from "react";
import { fetchRunDetail } from "../../data/benchmark/api";
import { formatDuration } from "../../data/benchmark/metrics";
import { guessResultLabel, guessResultTone } from "../../data/benchmark/runStatus";
import type {
  GuessRecord,
  LlmProposalRecord,
  SolvePromptRecord,
  StrategyRunDetail,
} from "../../data/benchmark/types";
import { StatusPill } from "./StatusPill";

export interface GuessChainVisualizerProps {
  runId: number;
}

/** Full detail for one run: for LLM strategies, the reconstructed
 * prompt -> candidate proposals -> guess outcome chain (solvePrompts is
 * populated); for everything else, a plain ordered guess list. Fetches its
 * own detail per runId so a multi-run picker can swap the visualized run
 * without the parent page owning the fetch/loading state. */
export function GuessChainVisualizer({ runId }: GuessChainVisualizerProps) {
  const [detail, setDetail] = useState<StrategyRunDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      <h2 className="bench-visualizer__title">Guess chain</h2>
      <p className="bench-mono bench-visualizer__runid">#{runId}</p>

      {isLoading ? <p className="bench-muted">Loading guess chain…</p> : null}
      {error && !isLoading ? <p className="bench-error">{error}</p> : null}

      {detail && !isLoading && !error ? (
        detail.solvePrompts.length > 0 ? (
          <PromptChain solvePrompts={detail.solvePrompts} />
        ) : (
          <PlainGuessList guesses={detail.guesses} />
        )
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
        {prompt.wordsHadParenthetical ? (
          <span title="This response tucked an explanation into the Words: line — the parser stripped it before guessing.">
            <StatusPill label="Parenthetical stripped" tone="neutral" />
          </span>
        ) : null}
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

      <ul className="bench-proposals">
        {prompt.proposals.map((proposal) => (
          <ProposalRow key={proposal.id} proposal={proposal} />
        ))}
        {prompt.proposals.length === 0 ? (
          <li className="bench-muted bench-proposals__empty">No candidate groups parsed.</li>
        ) : null}
      </ul>
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
    case "malformedGroupCount":
      return "Bad group count";
    case "malformedOther":
      return "Malformed";
    case "parsed":
      return "Parsed";
  }
}
