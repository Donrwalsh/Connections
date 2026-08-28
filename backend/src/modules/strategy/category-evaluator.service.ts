import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { loadEnv } from "../../config/env";
import { Puzzle } from "../game/entities/puzzle.entity";
import { AnswerGroup } from "../game/entities/answer-group.entity";
import {
  CategoryEvaluation,
  CategoryEvalStatus,
  CategoryEvalVerdict,
} from "./entities/category-evaluation.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { GuessResult } from "./entities/guess.entity";
import { OrchestratorService } from "./orchestrator.service";

// Bump only when buildJudgePrompt (orchestrator) changes materially, so a
// later re-judge pass can find rows produced by an older prompt. Nothing
// reads it yet.
export const EVALUATOR_VERSION = 1;

const VERDICT_BY_STRING: Record<string, CategoryEvalVerdict> = {
  correct: CategoryEvalVerdict.CORRECT,
  partial: CategoryEvalVerdict.PARTIAL,
  lucky: CategoryEvalVerdict.LUCKY,
};

function wordSetKey(words: string[]): string {
  return [...words].map((w) => w.trim().toUpperCase()).sort().join("|");
}

/** The puzzle answer group whose member words equal `guessWords` as a set. */
export function matchAnswerGroup(guessWords: string[], puzzle: Puzzle): AnswerGroup | null {
  const target = wordSetKey(guessWords);
  for (const group of puzzle.answerGroups ?? []) {
    if (wordSetKey(group.members.map((m) => m.word)) === target) {
      return group;
    }
  }
  return null;
}

export interface EvaluateProposalResult {
  outcome: "judged" | "callError" | "skipped";
  reason?: string;
}

@Injectable()
export class CategoryEvaluatorService {
  private readonly logger = new Logger(CategoryEvaluatorService.name);
  private readonly judgeModel = loadEnv().JUDGE_MODEL;
  private readonly judgeProvider = loadEnv().JUDGE_PROVIDER as "openai" | "ollama" | "google";

  constructor(
    @InjectRepository(CategoryEvaluation)
    private readonly categoryEvalRepo: Repository<CategoryEvaluation>,
    @InjectRepository(LlmProposal)
    private readonly llmProposalRepo: Repository<LlmProposal>,
    @InjectRepository(Puzzle)
    private readonly puzzleRepo: Repository<Puzzle>,
    @Inject(OrchestratorService)
    private readonly orchestrator: OrchestratorService,
  ) {}

  /**
   * Judge one proposal's category. Idempotent: a no-op if a row already
   * exists (unless `force`). Writes exactly one CategoryEvaluation row on a
   * judged or callError outcome; writes nothing (and returns "skipped") when
   * the proposal isn't a successful used guess or its winning word set
   * matches no answer group.
   */
  async evaluateProposal(
    llmProposalId: number,
    opts: { force?: boolean } = {},
  ): Promise<EvaluateProposalResult> {
    const existing = await this.categoryEvalRepo.findOne({ where: { llmProposalId } });
    if (existing && !opts.force) {
      return { outcome: "skipped", reason: "already evaluated" };
    }

    const proposal = await this.llmProposalRepo.findOne({
      where: { id: llmProposalId },
      relations: { guess: true },
    });
    if (
      !proposal ||
      proposal.status !== LlmProposalStatus.USED ||
      !proposal.guess ||
      proposal.guess.result !== GuessResult.SUCCESS
    ) {
      this.logger.warn(`Proposal ${llmProposalId} is not a successful used guess — skipping.`);
      return { outcome: "skipped", reason: "not a successful used guess" };
    }

    const puzzle = await this.puzzleRepo.findOne({
      where: { id: proposal.guess.puzzleId },
      relations: { answerGroups: { members: true } },
    });
    const group = puzzle ? matchAnswerGroup(proposal.guess.words, puzzle) : null;
    if (!group) {
      this.logger.warn(
        `Proposal ${llmProposalId}: winning word set matched no answer group on puzzle ${proposal.guess.puzzleId} — skipping.`,
      );
      return { outcome: "skipped", reason: "no matching answer group" };
    }

    const proposedCategory = proposal.category;
    const actualCategory = group.group_name;

    const outcome = await this.orchestrator.judgeCategory(
      proposedCategory,
      actualCategory,
      this.judgeModel,
      this.judgeProvider,
    );

    const base = {
      llmProposalId,
      strategyRunId: proposal.strategyRunId,
      answerGroupId: group.id,
      proposedCategory,
      actualCategory,
      evaluatorVersion: EVALUATOR_VERSION,
      judgeModel: this.judgeModel,
      judgeProvider: this.judgeProvider,
    };

    if (outcome.ok) {
      const d = outcome.data;
      await this.categoryEvalRepo.save({
        ...(existing ? { id: existing.id } : {}),
        ...base,
        status: CategoryEvalStatus.JUDGED,
        verdict: VERDICT_BY_STRING[d.verdict],
        rationale: d.rationale,
        judgeModel: d.model || this.judgeModel,
        requestBody: d.requestBody ?? null,
        responseId: d.responseId ?? null,
        responseHeaders: d.responseHeaders ?? null,
        responseBody: d.responseBody ?? null,
        rawResponseText: d.rawResponseText ?? null,
        promptTokens: d.usage?.promptTokens ?? null,
        completionTokens: d.usage?.completionTokens ?? null,
        totalTokens: d.usage?.totalTokens ?? null,
        latencyMs: d.latencyMs ?? null,
        statusCode: null,
        errorName: null,
        errorMessage: null,
        isRetryable: null,
        temperature: 0,
      });
      return { outcome: "judged" };
    }

    const e = outcome.error;
    await this.categoryEvalRepo.save({
      ...(existing ? { id: existing.id } : {}),
      ...base,
      status: CategoryEvalStatus.CALL_ERROR,
      verdict: null,
      rationale: null,
      requestBody: e.requestBody ?? null,
      responseId: e.responseId ?? null,
      responseHeaders: e.responseHeaders ?? null,
      responseBody: e.responseBody ?? null,
      rawResponseText: null,
      statusCode: e.statusCode ?? null,
      errorName: e.errorName ?? null,
      errorMessage: e.error ?? null,
      isRetryable: e.isRetryable ?? null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      latencyMs: null,
      temperature: null,
    });
    return { outcome: "callError" };
  }
}
