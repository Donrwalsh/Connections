import { handleLlmJob } from "./llm-job-handler";

const logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as never;

describe("handleLlmJob", () => {
  it("routes an evaluate-category job to the evaluator, not the strategy runner", async () => {
    const runner = { runLlmStrategy: jest.fn() };
    const evaluator = { evaluateProposal: jest.fn().mockResolvedValue({ outcome: "judged" }) };
    const job = { id: "j1", name: "evaluate-category", data: { llmProposalId: 77 } };

    const result = await handleLlmJob(job as never, {
      llmStrategyRunner: runner as never,
      categoryEvaluatorService: evaluator as never,
      expectedStrategy: "llm-openai",
      logger,
    });

    expect(evaluator.evaluateProposal).toHaveBeenCalledWith(77);
    expect(runner.runLlmStrategy).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "judged" });
  });

  it("routes a run-strategy job to the strategy runner", async () => {
    const runner = { runLlmStrategy: jest.fn().mockResolvedValue({ status: "completed" }) };
    const evaluator = { evaluateProposal: jest.fn() };
    const job = {
      id: "j2",
      name: "run-strategy",
      data: { puzzleId: 1, strategyName: "llm-openai", date: "2024-01-01", trialNumber: 1, model: "gpt-4.1-nano" },
    };

    await handleLlmJob(job as never, {
      llmStrategyRunner: runner as never,
      categoryEvaluatorService: evaluator as never,
      expectedStrategy: "llm-openai",
      logger,
    });

    expect(runner.runLlmStrategy).toHaveBeenCalledWith(1, "llm-openai", 1, "gpt-4.1-nano");
    expect(evaluator.evaluateProposal).not.toHaveBeenCalled();
  });

  it("throws when a run-strategy job's strategy doesn't match the queue", async () => {
    const job = { id: "j3", name: "run-strategy", data: { puzzleId: 1, strategyName: "llm-google", trialNumber: 1 } };
    await expect(
      handleLlmJob(job as never, {
        llmStrategyRunner: { runLlmStrategy: jest.fn() } as never,
        categoryEvaluatorService: { evaluateProposal: jest.fn() } as never,
        expectedStrategy: "llm-openai",
        logger,
      }),
    ).rejects.toThrow(/expected 'llm-openai'/);
  });
});
