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
import { Queue } from "bullmq";
import { LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, LLM_GOOGLE_QUEUE } from "../queue/queue.module";
import { queueForJudgeProvider, categoryEvalJobId } from "../queue/strategy.queue";

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

/** How much of the judge-eligible backlog has been evaluated — `eligible`
 * is every used proposal whose guess succeeded, `judged` is how many of
 * those already have a CategoryEvaluation row (a callError row counts:
 * enqueuePending won't re-pick it without force), `pending` is the
 * difference and equals what the next dispatch would enqueue. */
export interface CategoryEvaluationCoverage {
  eligible: number;
  judged: number;
  pending: number;
}

@Injectable()
export class CategoryEvaluatorService {
  private readonly logger = new Logger(CategoryEvaluatorService.name);
  private readonly judgeModel = loadEnv().JUDGE_MODEL;
  private readonly judgeProvider = loadEnv().JUDGE_PROVIDER;

  constructor(
    @InjectRepository(CategoryEvaluation)
    private readonly categoryEvalRepo: Repository<CategoryEvaluation>,
    @InjectRepository(LlmProposal)
    private readonly llmProposalRepo: Repository<LlmProposal>,
    @InjectRepository(Puzzle)
    private readonly puzzleRepo: Repository<Puzzle>,
    @Inject(OrchestratorService)
    private readonly orchestrator: OrchestratorService,
    @Inject(LLM_OPENAI_QUEUE) private readonly llmOpenAIQueue: Queue,
    @Inject(LLM_OLLAMA_QUEUE) private readonly llmOllamaQueue: Queue,
    @Inject(LLM_GOOGLE_QUEUE) private readonly llmGoogleQueue: Queue,
  ) {}

  private readonly DEFAULT_LIMIT = 50;
  private readonly MAX_LIMIT = 500;

  /**
   * Enqueue one `evaluate-category` job per not-yet-evaluated successful
   * used proposal, newest LlmProposal.id first, up to `limit`. Jobs land on
   * the judge provider's LLM queue (deterministic jobId so a re-enqueue of a
   * still-pending job collapses). Returns what was queued.
   */
  async enqueuePending(opts: { limit?: number; force?: boolean } = {}): Promise<{
    enqueued: number;
    llmProposalIds: number[];
  }> {
    const raw = Number(opts.limit);
    const limit = Number.isFinite(raw)
      ? Math.min(this.MAX_LIMIT, Math.max(1, Math.floor(raw)))
      : this.DEFAULT_LIMIT;
    const force = Boolean(opts.force);

    const qb = this.llmProposalRepo
      .createQueryBuilder("proposal")
      .innerJoin("proposal.guess", "guess", "guess.result = :success", { success: GuessResult.SUCCESS })
      .leftJoin(CategoryEvaluation, "ce", 'ce."llmProposalId" = proposal.id')
      .where("proposal.status = :used", { used: LlmProposalStatus.USED });

    // Without --force, only enqueue proposals that have no CategoryEvaluation
    // row yet. With --force, re-select every used+SUCCESS proposal so the
    // worker can overwrite an existing evaluation.
    if (!force) {
      qb.andWhere("ce.id IS NULL");
    }

    const rows = await qb
      .orderBy("proposal.id", "DESC")
      .limit(limit)
      .select("proposal.id", "id")
      .getRawMany<{ id: number }>();

    const queue = queueForJudgeProvider(
      this.judgeProvider,
      this.llmOpenAIQueue,
      this.llmOllamaQueue,
      this.llmGoogleQueue,
    );

    const llmProposalIds = rows.map((r) => Number(r.id));
    for (const id of llmProposalIds) {
      // A deterministic jobId collapses a re-enqueue of a still-pending job
      // (the intended non-force behavior). But BullMQ silently drops an add
      // whose jobId hash still exists from a *completed* job (LLM queues keep
      // removeOnComplete: { count: 1000 }), so a --force re-judge right after
      // a batch finished would enqueue nothing. Force opts out with a
      // unique jobId so the re-judge always runs.
      const jobId = force ? `${categoryEvalJobId(id)}-${Date.now()}` : categoryEvalJobId(id);
      await queue.add(
        "evaluate-category",
        force ? { llmProposalId: id, force: true } : { llmProposalId: id },
        { jobId },
      );
    }

    return { enqueued: llmProposalIds.length, llmProposalIds };
  }

  /**
   * Judge-coverage totals for the Activity page's "how much is left to
   * dispatch" widget. `eligible` / `judged` come from the same used +
   * successful-guess join as enqueuePending, with a LEFT JOIN onto
   * CategoryEvaluation; `pending` (eligible − judged) is exactly what an
   * un-forced dispatch would enqueue next.
   */
  async getCoverage(): Promise<CategoryEvaluationCoverage> {
    const row = await this.llmProposalRepo
      .createQueryBuilder("proposal")
      .innerJoin("proposal.guess", "guess", "guess.result = :success", {
        success: GuessResult.SUCCESS,
      })
      .leftJoin(CategoryEvaluation, "ce", 'ce."llmProposalId" = proposal.id')
      .where("proposal.status = :used", { used: LlmProposalStatus.USED })
      .select("COUNT(*)::int", "eligible")
      .addSelect("COUNT(ce.id)::int", "judged")
      .getRawOne<{ eligible: number | string; judged: number | string }>();

    const eligible = Number(row?.eligible ?? 0);
    const judged = Number(row?.judged ?? 0);
    return { eligible, judged, pending: eligible - judged };
  }

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
        // Mirrors JUDGE_TEMPERATURE in orchestrator/src/judge-category.ts —
        // the orchestrator doesn't return the value it used, so keep this in
        // sync by hand if that constant ever changes.
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
