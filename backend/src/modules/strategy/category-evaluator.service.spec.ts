import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { CategoryEvaluatorService, matchAnswerGroup } from "./category-evaluator.service";
import { CategoryEvaluation, CategoryEvalStatus, CategoryEvalVerdict } from "./entities/category-evaluation.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { Guess, GuessResult } from "./entities/guess.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { OrchestratorService } from "./orchestrator.service";
import { LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, LLM_GOOGLE_QUEUE } from "../queue/queue.module";

const puzzle = {
  id: 7,
  answerGroups: [
    { id: 100, group_name: "___ COBBLER", members: [{ word: "APPLE" }, { word: "PEACH" }, { word: "SHOE" }, { word: "COBBLE" }] },
    { id: 101, group_name: "Citrus", members: [{ word: "LIME" }, { word: "LEMON" }, { word: "ORANGE" }, { word: "CITRON" }] },
  ],
} as unknown as Puzzle;

describe("matchAnswerGroup", () => {
  it("matches by word set regardless of order", () => {
    const group = matchAnswerGroup(["SHOE", "APPLE", "COBBLE", "PEACH"], puzzle);
    expect(group?.id).toBe(100);
  });
  it("returns null when no group's members equal the guess word set", () => {
    expect(matchAnswerGroup(["APPLE", "PEACH", "SHOE", "LIME"], puzzle)).toBeNull();
  });
});

describe("CategoryEvaluatorService.evaluateProposal", () => {
  let service: CategoryEvaluatorService;
  let catEvalRepo: { findOne: jest.Mock; save: jest.Mock };
  let llmProposalRepo: { findOne: jest.Mock };
  let puzzleRepo: { findOne: jest.Mock };
  let orchestrator: { judgeCategory: jest.Mock };

  const usedProposal = {
    id: 55,
    strategyRunId: 9,
    category: "Fruits",
    status: LlmProposalStatus.USED,
    guess: { id: 3, puzzleId: 7, words: ["APPLE", "PEACH", "SHOE", "COBBLE"], result: GuessResult.SUCCESS } as Guess,
  } as unknown as LlmProposal;

  beforeEach(async () => {
    // Field initializers on CategoryEvaluatorService call loadEnv(), which
    // requires INTERNAL_API_KEY. The unit-test Jest config has no setupFiles
    // (only the e2e config does), so set it here the same way
    // orchestrator.service.spec.ts / app.service.spec.ts do.
    process.env.INTERNAL_API_KEY = "test-key";

    catEvalRepo = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn().mockImplementation((r) => r) };
    llmProposalRepo = { findOne: jest.fn().mockResolvedValue(usedProposal) };
    puzzleRepo = { findOne: jest.fn().mockResolvedValue(puzzle) };
    orchestrator = {
      judgeCategory: jest.fn().mockResolvedValue({
        ok: true,
        data: {
          verdict: "partial",
          rationale: "Saw fruit, missed the wordplay.",
          model: "gpt-4.1-nano",
          latencyMs: 20,
          usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100 },
          requestBody: { a: 1 },
          responseHeaders: { h: "v" },
          responseBody: { ok: true },
          rawResponseText: '{"verdict":"partial"}',
        },
      }),
    };

    const noopQueue = { add: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryEvaluatorService,
        { provide: getRepositoryToken(CategoryEvaluation), useValue: catEvalRepo },
        { provide: getRepositoryToken(LlmProposal), useValue: llmProposalRepo },
        { provide: getRepositoryToken(Puzzle), useValue: puzzleRepo },
        { provide: OrchestratorService, useValue: orchestrator },
        { provide: LLM_OPENAI_QUEUE, useValue: noopQueue },
        { provide: LLM_OLLAMA_QUEUE, useValue: noopQueue },
        { provide: LLM_GOOGLE_QUEUE, useValue: noopQueue },
      ],
    }).compile();
    service = module.get(CategoryEvaluatorService);
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    jest.restoreAllMocks();
  });

  it("writes one judged row with the verdict and diagnostics", async () => {
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("judged");
    expect(catEvalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        llmProposalId: 55,
        strategyRunId: 9,
        answerGroupId: 100,
        verdict: CategoryEvalVerdict.PARTIAL,
        rationale: "Saw fruit, missed the wordplay.",
        proposedCategory: "Fruits",
        actualCategory: "___ COBBLER",
        status: CategoryEvalStatus.JUDGED,
        judgeModel: "gpt-4.1-nano",
        promptTokens: 90,
        completionTokens: 10,
        requestBody: { a: 1 },
      }),
    );
  });

  it("writes a callError row (verdict null) without throwing when the judge fails", async () => {
    orchestrator.judgeCategory.mockResolvedValue({
      ok: false,
      error: { error: "boom", code: "model_error", errorName: "APICallError", statusCode: 502, isRetryable: true },
    });
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("callError");
    expect(catEvalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: CategoryEvalStatus.CALL_ERROR,
        verdict: null,
        errorName: "APICallError",
        errorMessage: "boom",
        isRetryable: true,
        statusCode: 502,
        answerGroupId: 100,
      }),
    );
  });

  it("skips (no judge call, no row) when a row already exists and force is not set", async () => {
    catEvalRepo.findOne.mockResolvedValue({ id: 1 });
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("skipped");
    expect(orchestrator.judgeCategory).not.toHaveBeenCalled();
    expect(catEvalRepo.save).not.toHaveBeenCalled();
  });

  it("re-judges and UPDATEs the existing row (id spread) when force is set", async () => {
    catEvalRepo.findOne.mockResolvedValue({ id: 42 });
    const res = await service.evaluateProposal(55, { force: true });
    expect(res.outcome).toBe("judged");
    expect(orchestrator.judgeCategory).toHaveBeenCalled();
    expect(catEvalRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        llmProposalId: 55,
        verdict: CategoryEvalVerdict.PARTIAL,
      }),
    );
  });

  it("skips when the proposal is not a successful used guess", async () => {
    llmProposalRepo.findOne.mockResolvedValue({ ...usedProposal, guess: { ...usedProposal.guess, result: GuessResult.FAILURE } });
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("skipped");
    expect(orchestrator.judgeCategory).not.toHaveBeenCalled();
  });

  it("skips (no row written) when the winning word set matches no answer group", async () => {
    llmProposalRepo.findOne.mockResolvedValue({
      ...usedProposal,
      guess: { ...usedProposal.guess, words: ["APPLE", "PEACH", "SHOE", "LIME"] },
    });
    const res = await service.evaluateProposal(55);
    expect(res.outcome).toBe("skipped");
    expect(catEvalRepo.save).not.toHaveBeenCalled();
  });
});
