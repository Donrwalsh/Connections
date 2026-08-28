import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import type { LlmStrategyRunner } from "./llm-strategy-runner.service";
import type { CategoryEvaluatorService } from "./category-evaluator.service";

export interface RunStrategyJobData {
  puzzleId: number;
  strategyName: string;
  date: string;
  trialNumber: number;
  // The dispatcher already validated this against the SupportedModel table
  // before enqueueing (StrategyService/PuzzleIngestionService) — null/absent
  // for non-LLM strategies, which don't have a model at all.
  model?: string | null;
}

export interface LlmJobDeps {
  llmStrategyRunner: LlmStrategyRunner;
  categoryEvaluatorService: CategoryEvaluatorService;
  expectedStrategy: string;
  logger: Logger;
}

/**
 * Body of the per-provider LLM worker. Two job kinds share the queue:
 * `evaluate-category` (LLM-judge a proposal's category — see
 * CategoryEvaluatorService) and everything else (`run-strategy`, an actual
 * solve run). Exported so the routing is unit-testable without BullMQ.
 */
export async function handleLlmJob(
  job: Job<RunStrategyJobData | { llmProposalId: number }>,
  deps: LlmJobDeps,
): Promise<unknown> {
  if (job.name === "evaluate-category") {
    const { llmProposalId } = job.data as { llmProposalId: number };
    deps.logger.log(`starting job ${job.id}: evaluate-category proposal=${llmProposalId}`);
    const result = await deps.categoryEvaluatorService.evaluateProposal(llmProposalId);
    deps.logger.log(
      `finished job ${job.id}: evaluate-category proposal=${llmProposalId} outcome=${result.outcome}`,
    );
    return result;
  }

  const { puzzleId, strategyName, date, trialNumber, model } = job.data as RunStrategyJobData;
  if (strategyName !== deps.expectedStrategy) {
    throw new Error(
      `Strategy '${strategyName}' dispatched to the '${deps.expectedStrategy}' queue for puzzle ${puzzleId}; expected '${deps.expectedStrategy}'`,
    );
  }
  deps.logger.log(
    `starting job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber}`,
  );
  const result = await deps.llmStrategyRunner.runLlmStrategy(
    puzzleId,
    strategyName,
    trialNumber,
    model ?? undefined,
  );
  deps.logger.log(
    `finished job ${job.id}: puzzle=${puzzleId} date=${date} strategy=${strategyName} trial=${trialNumber} status=${result.status}`,
  );
  return result;
}
