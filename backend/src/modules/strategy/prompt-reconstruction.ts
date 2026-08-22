import type { Guess } from "./entities/guess.entity";
import { GuessResult } from "./entities/guess.entity";
import type { LlmProposal } from "./entities/llm-proposal.entity";
import { LlmProposalStatus } from "./entities/llm-proposal.entity";
import type { SolvePrompt } from "./entities/solve-prompt.entity";
import { SolvePromptStatus, SolvePromptType } from "./entities/solve-prompt.entity";
import { buildInitialPrompt, buildRetryPrompt } from "./llm-strategy-runner.service";
import type { LlmProposalDto, SolvePromptDto } from "./dto/strategy.dto";

const GROUP_SIZE = 4;

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// Matches the "[User]\n.../n\n[Assistant]\n..." format Game.tsx already uses
// to display the live AI Assist conversation, so a reconstructed run's
// prompt reads the same way a real one would. Exported so tests can build
// expected strings from the same formatting logic rather than duplicating it.
export function formatConversation(turns: ConversationTurn[]): string {
  return turns
    .map((turn) => `[${turn.role === "user" ? "User" : "Assistant"}]\n${turn.content}`)
    .join("\n\n");
}

/**
 * Rebuilds the exact prompt text sent to the model at each solve step of an
 * LLM run. The runner (llm-strategy-runner.service.ts) never persists prompt
 * text, only the response — so this replays buildInitialPrompt/buildRetryPrompt
 * with the same inputs the runner had in memory at that point: the run's
 * starting word order (computeInitialWordOrder) plus whatever
 * availableWords/lockedInGroups/lastFailedGuess state the *stored* guesses
 * imply. Every real OpenAI call attempt now gets its own SolvePrompt row,
 * including ones that failed outright and never produced model text
 * (SolvePromptStatus.CALL_ERROR — rawResponseText stays null for those).
 * Those rows never mutated the runner's conversation state, so they don't
 * correspond to a real transcript turn; the caller (strategy.service.ts's
 * buildSolvePromptDtos) excludes them from the query before handing prompts
 * here, and this function additionally filters them out itself below, since
 * folding one into `history` would corrupt every later step's
 * reconstructedPrompt for the rest of the run — cheap enough to guard
 * against directly rather than relying solely on the caller.
 *
 * The runner sends the *entire* conversation history on every call (it's a
 * chat completion, not a one-shot prompt), so `reconstructedPrompt` for step
 * N is the full transcript — every earlier step's prompt and response,
 * followed by step N's own newly-built prompt — not just step N's message in
 * isolation.
 */
export function reconstructSolvePrompts(
  originalWords: string[],
  solvePrompts: SolvePrompt[],
  proposals: LlmProposal[],
  guessesById: Map<number, Guess>,
): SolvePromptDto[] {
  const proposalsByPrompt = new Map<number, LlmProposal[]>();
  for (const proposal of proposals) {
    const list = proposalsByPrompt.get(proposal.solvePromptId) ?? [];
    list.push(proposal);
    proposalsByPrompt.set(proposal.solvePromptId, list);
  }

  // See the docblock above: a CALL_ERROR row shouldn't be here (the caller
  // is expected to have already excluded them), but skip any anyway rather
  // than trust that invariant blindly. Multiple rows can now share one
  // promptNumber (a step's retried-then-succeeded attempts), so attemptNumber
  // is a tiebreak keeping a step's own rows in call order.
  const orderedPrompts = [...solvePrompts]
    .filter((prompt) => prompt.status !== SolvePromptStatus.CALL_ERROR)
    .sort((a, b) => a.promptNumber - b.promptNumber || a.attemptNumber - b.attemptNumber);

  let availableWords = [...originalWords];
  const lockedInGroups: string[][] = [];
  let lastFailedGuess: { items: string[]; result: string } | null = null;
  // Every earlier step's (user, assistant) turn pair, in order — mirrors the
  // runner's own `messages` array. A step whose orchestrator call failed
  // outright never got appended to the live `messages` either (the runner
  // pops it back off) — CALL_ERROR rows are filtered out of `orderedPrompts`
  // above for exactly this reason, so every row seen here corresponds to a
  // real turn.
  const history: ConversationTurn[] = [];

  return orderedPrompts.map((prompt) => {
    const N = availableWords.length / GROUP_SIZE;

    // The live runner only ever builds a RETRY prompt when lastFailedGuess is
    // set (that's the branch condition), so the `lastFailedGuess` guard below
    // is purely defensive against stored data that (for whatever reason)
    // doesn't match that invariant — falls back to INITIAL rather than
    // throwing, since a best-effort reconstruction beats none.
    const currentPrompt =
      prompt.promptType === SolvePromptType.RETRY && lastFailedGuess
        ? buildRetryPrompt(availableWords, lockedInGroups, lastFailedGuess, N)
        : buildInitialPrompt(availableWords, N);

    const reconstructedPrompt = formatConversation([
      ...history,
      { role: "user", content: currentPrompt },
    ]);

    history.push({ role: "user", content: currentPrompt });
    history.push({ role: "assistant", content: prompt.rawResponseText ?? "" });

    const promptProposals: LlmProposalDto[] = (proposalsByPrompt.get(prompt.id) ?? [])
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((proposal) => {
        const guess = proposal.guessId !== null ? guessesById.get(proposal.guessId) : undefined;
        return {
          id: proposal.id,
          words: proposal.words,
          category: proposal.category,
          status: proposal.status,
          guess: guess
            ? {
                sequenceNumber: guess.sequenceNumber,
                result: guess.result,
                guessedAt: guess.guessedAt,
              }
            : null,
        };
      });

    // Advance state using the proposals this step actually submitted as
    // guesses, in the order they were submitted — mirrors the runner's own
    // sequential evaluate-until-failure loop.
    const usedSteps = promptProposals
      .filter(
        (proposal): proposal is LlmProposalDto & { guess: NonNullable<LlmProposalDto["guess"]> } =>
          proposal.status === LlmProposalStatus.USED && proposal.guess !== null,
      )
      .sort((a, b) => a.guess.sequenceNumber - b.guess.sequenceNumber);

    for (const step of usedSteps) {
      if (step.guess.result === GuessResult.SUCCESS) {
        availableWords = availableWords.filter((word) => !step.words.includes(word));
        lockedInGroups.push(step.words);
        lastFailedGuess = null;
      } else {
        const resultStr = step.guess.result === GuessResult.OFF_BY_ONE ? "one away" : "incorrect";
        lastFailedGuess = { items: step.words, result: resultStr };
      }
    }

    return {
      id: prompt.id,
      promptNumber: prompt.promptNumber,
      promptType: prompt.promptType,
      status: prompt.status,
      rawResponseText: prompt.rawResponseText,
      promptTokens: prompt.promptTokens,
      completionTokens: prompt.completionTokens,
      totalTokens: prompt.totalTokens,
      latencyMs: prompt.latencyMs,
      temperature: prompt.temperature,
      createdAt: prompt.createdAt,
      wordsHadParenthetical: prompt.wordsHadParenthetical,
      reconstructedPrompt,
      proposals: promptProposals,
    };
  });
}
