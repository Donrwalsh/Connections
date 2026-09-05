import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { CategoryEvaluatorService, matchAnswerGroup } from "./category-evaluator.service";
import {
  CategoryEvaluation,
  CategoryEvalStatus,
  CategoryEvalVerdict,
} from "./entities/category-evaluation.entity";
import { LlmProposal, LlmProposalStatus } from "./entities/llm-proposal.entity";
import { StrategyRun } from "./entities/strategy-run.entity";
import { Guess, GuessResult } from "./entities/guess.entity";
import { Puzzle } from "../game/entities/puzzle.entity";
import { OrchestratorService } from "./orchestrator.service";
import { LLM_OPENAI_QUEUE, LLM_OLLAMA_QUEUE, LLM_GOOGLE_QUEUE } from "../queue/queue.module";

const puzzle = {
  id: 7,
  answerGroups: [
    {
      id: 100,
      group_name: "___ COBBLER",
      members: [{ word: "APPLE" }, { word: "PEACH" }, { word: "SHOE" }, { word: "COBBLE" }],
    },
    {
      id: 101,
      group_name: "Citrus",
      members: [{ word: "LIME" }, { word: "LEMON" }, { word: "ORANGE" }, { word: "CITRON" }],
    },
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
    guess: {
      id: 3,
      puzzleId: 7,
      words: ["APPLE", "PEACH", "SHOE", "COBBLE"],
      result: GuessResult.SUCCESS,
    } as Guess,
  } as unknown as LlmProposal;

  beforeEach(async () => {
    // Field initializers on CategoryEvaluatorService call loadEnv(), which
    // requires INTERNAL_API_KEY. The unit-test Jest config has no setupFiles
    // (only the e2e config does), so set it here the same way
    // orchestrator.service.spec.ts / app.service.spec.ts do.
    process.env.INTERNAL_API_KEY = "test-key";

    catEvalRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((r) => r),
    };
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
        {
          provide: getRepositoryToken(StrategyRun),
          useValue: { findOne: jest.fn(), delete: jest.fn() },
        },
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
      error: {
        error: "boom",
        code: "model_error",
        errorName: "APICallError",
        statusCode: 502,
        isRetryable: true,
      },
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
    llmProposalRepo.findOne.mockResolvedValue({
      ...usedProposal,
      guess: { ...usedProposal.guess, result: GuessResult.FAILURE },
    });
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

describe("CategoryEvaluatorService.enqueuePending", () => {
  let service: CategoryEvaluatorService;
  let openaiAdd: jest.Mock;
  let qb: Record<string, jest.Mock>;

  beforeEach(async () => {
    // See the evaluateProposal block: CategoryEvaluatorService field
    // initializers call loadEnv(), which requires INTERNAL_API_KEY, and the
    // unit-test Jest config has no setupFiles.
    process.env.INTERNAL_API_KEY = "test-key";

    openaiAdd = jest.fn().mockResolvedValue(undefined);
    qb = {
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ id: 90 }, { id: 88 }, { id: 80 }]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryEvaluatorService,
        {
          provide: getRepositoryToken(CategoryEvaluation),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(LlmProposal),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn().mockReturnValue(qb) },
        },
        { provide: getRepositoryToken(Puzzle), useValue: { findOne: jest.fn() } },
        {
          provide: getRepositoryToken(StrategyRun),
          useValue: { findOne: jest.fn(), delete: jest.fn() },
        },
        { provide: OrchestratorService, useValue: { judgeCategory: jest.fn() } },
        { provide: LLM_OPENAI_QUEUE, useValue: { add: openaiAdd } },
        { provide: LLM_OLLAMA_QUEUE, useValue: { add: jest.fn() } },
        { provide: LLM_GOOGLE_QUEUE, useValue: { add: jest.fn() } },
      ],
    }).compile();
    service = module.get(CategoryEvaluatorService);
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    jest.restoreAllMocks();
  });

  it("adds one evaluate-category job per un-evaluated proposal to the judge provider's queue", async () => {
    const res = await service.enqueuePending({ limit: 10 });
    expect(res).toEqual({ enqueued: 3, llmProposalIds: [90, 88, 80] });
    expect(openaiAdd).toHaveBeenCalledTimes(3);
    expect(openaiAdd).toHaveBeenCalledWith(
      "evaluate-category",
      { llmProposalId: 90 },
      { jobId: "cat-eval-90" },
    );
    expect(qb.limit).toHaveBeenCalledWith(10);
  });

  it("clamps limit to 1..500", async () => {
    await service.enqueuePending({ limit: 99999 });
    expect(qb.limit).toHaveBeenCalledWith(500);
  });

  it("falls back to the default limit (50) for a non-numeric limit rather than passing NaN", async () => {
    await service.enqueuePending({ limit: NaN });
    expect(qb.limit).toHaveBeenCalledWith(50);
    await service.enqueuePending({ limit: Number("abc") });
    expect(qb.limit).toHaveBeenLastCalledWith(50);
  });

  it("with force: skips the ce.id IS NULL filter and puts force: true in the job data", async () => {
    await service.enqueuePending({ force: true });
    expect(qb.andWhere).not.toHaveBeenCalledWith(expect.stringContaining("ce.id IS NULL"));
    expect(openaiAdd).toHaveBeenCalledWith(
      "evaluate-category",
      { llmProposalId: 90, force: true },
      { jobId: expect.stringMatching(/^cat-eval-90-\d+$/) },
    );
    // The force path must NOT reuse the deterministic jobId, or BullMQ's
    // completed-job dedupe silently drops the re-judge.
    expect(openaiAdd).not.toHaveBeenCalledWith("evaluate-category", expect.anything(), {
      jobId: "cat-eval-90",
    });
  });
});

describe("CategoryEvaluatorService.getCoverage", () => {
  let service: CategoryEvaluatorService;
  let qb: Record<string, jest.Mock>;

  beforeEach(async () => {
    process.env.INTERNAL_API_KEY = "test-key";
    qb = {
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ eligible: 50, judged: 42 }),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryEvaluatorService,
        {
          provide: getRepositoryToken(CategoryEvaluation),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(LlmProposal),
          useValue: { findOne: jest.fn(), createQueryBuilder: jest.fn().mockReturnValue(qb) },
        },
        { provide: getRepositoryToken(Puzzle), useValue: { findOne: jest.fn() } },
        {
          provide: getRepositoryToken(StrategyRun),
          useValue: { findOne: jest.fn(), delete: jest.fn() },
        },
        { provide: OrchestratorService, useValue: { judgeCategory: jest.fn() } },
        { provide: LLM_OPENAI_QUEUE, useValue: { add: jest.fn() } },
        { provide: LLM_OLLAMA_QUEUE, useValue: { add: jest.fn() } },
        { provide: LLM_GOOGLE_QUEUE, useValue: { add: jest.fn() } },
      ],
    }).compile();
    service = module.get(CategoryEvaluatorService);
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    jest.restoreAllMocks();
  });

  it("counts judge-eligible proposals (used + successful) against how many have an evaluation row", async () => {
    const result = await service.getCoverage();

    expect(result).toEqual({ eligible: 50, judged: 42, pending: 8 });
    expect(qb.where).toHaveBeenCalledWith("proposal.status = :used", {
      used: LlmProposalStatus.USED,
    });
    expect(qb.innerJoin).toHaveBeenCalledWith(
      "proposal.guess",
      "guess",
      "guess.result = :success",
      {
        success: GuessResult.SUCCESS,
      },
    );
    expect(qb.leftJoin).toHaveBeenCalledWith(
      CategoryEvaluation,
      "ce",
      'ce."llmProposalId" = proposal.id',
    );
  });

  it("coerces string counts from the raw driver and derives pending", async () => {
    qb.getRawOne.mockResolvedValue({ eligible: "12", judged: "12" });

    expect(await service.getCoverage()).toEqual({ eligible: 12, judged: 12, pending: 0 });
  });

  it("treats a missing row as all-zero", async () => {
    qb.getRawOne.mockResolvedValue(undefined);

    expect(await service.getCoverage()).toEqual({ eligible: 0, judged: 0, pending: 0 });
  });
});

describe("CategoryEvaluatorService.deleteRunEvaluations", () => {
  let service: CategoryEvaluatorService;
  let catEvalRepo: { delete: jest.Mock };
  let strategyRunRepo: { findOne: jest.Mock };

  beforeEach(async () => {
    process.env.INTERNAL_API_KEY = "test-key";
    catEvalRepo = { delete: jest.fn().mockResolvedValue({ affected: 3 }) };
    strategyRunRepo = { findOne: jest.fn().mockResolvedValue({ id: 42 }) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryEvaluatorService,
        {
          provide: getRepositoryToken(CategoryEvaluation),
          useValue: { findOne: jest.fn(), save: jest.fn(), ...catEvalRepo },
        },
        { provide: getRepositoryToken(LlmProposal), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Puzzle), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(StrategyRun), useValue: strategyRunRepo },
        { provide: OrchestratorService, useValue: { judgeCategory: jest.fn() } },
        { provide: LLM_OPENAI_QUEUE, useValue: { add: jest.fn() } },
        { provide: LLM_OLLAMA_QUEUE, useValue: { add: jest.fn() } },
        { provide: LLM_GOOGLE_QUEUE, useValue: { add: jest.fn() } },
      ],
    }).compile();
    service = module.get(CategoryEvaluatorService);
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    jest.restoreAllMocks();
  });

  it("deletes every CategoryEvaluation row for the run and reports the count", async () => {
    const result = await service.deleteRunEvaluations(42);

    expect(result).toEqual({ deleted: 3 });
    expect(catEvalRepo.delete).toHaveBeenCalledWith({ strategyRunId: 42 });
  });

  it("reports zero when the run has no evaluations", async () => {
    catEvalRepo.delete.mockResolvedValue({ affected: 0 });

    expect(await service.deleteRunEvaluations(42)).toEqual({ deleted: 0 });
  });

  it("throws NotFoundException for an unknown run and deletes nothing", async () => {
    strategyRunRepo.findOne.mockResolvedValue(null);

    await expect(service.deleteRunEvaluations(999)).rejects.toMatchObject({
      status: 404,
    });
    expect(catEvalRepo.delete).not.toHaveBeenCalled();
  });
});

describe("CategoryEvaluatorService failed-judge-call maintenance", () => {
  let service: CategoryEvaluatorService;
  let catEvalRepo: { delete: jest.Mock; count: jest.Mock };

  beforeEach(async () => {
    process.env.INTERNAL_API_KEY = "test-key";
    catEvalRepo = {
      delete: jest.fn().mockResolvedValue({ affected: 4 }),
      count: jest.fn().mockResolvedValue(4),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryEvaluatorService,
        {
          provide: getRepositoryToken(CategoryEvaluation),
          useValue: { findOne: jest.fn(), save: jest.fn(), ...catEvalRepo },
        },
        { provide: getRepositoryToken(LlmProposal), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Puzzle), useValue: { findOne: jest.fn() } },
        {
          provide: getRepositoryToken(StrategyRun),
          useValue: { findOne: jest.fn(), delete: jest.fn() },
        },
        { provide: OrchestratorService, useValue: { judgeCategory: jest.fn() } },
        { provide: LLM_OPENAI_QUEUE, useValue: { add: jest.fn() } },
        { provide: LLM_OLLAMA_QUEUE, useValue: { add: jest.fn() } },
        { provide: LLM_GOOGLE_QUEUE, useValue: { add: jest.fn() } },
      ],
    }).compile();
    service = module.get(CategoryEvaluatorService);
  });

  afterEach(() => {
    delete process.env.INTERNAL_API_KEY;
    jest.restoreAllMocks();
  });

  describe("countFailedEvaluations", () => {
    it("counts only the callError rows", async () => {
      catEvalRepo.count.mockResolvedValue(7);

      const result = await service.countFailedEvaluations();

      expect(result).toEqual({ failed: 7 });
      expect(catEvalRepo.count).toHaveBeenCalledWith({
        where: { status: CategoryEvalStatus.CALL_ERROR },
      });
    });
  });

  describe("deleteFailedEvaluations", () => {
    it("deletes every callError row so the next dispatch re-judges those proposals, and reports the count", async () => {
      const result = await service.deleteFailedEvaluations();

      expect(result).toEqual({ deleted: 4 });
      expect(catEvalRepo.delete).toHaveBeenCalledWith({
        status: CategoryEvalStatus.CALL_ERROR,
      });
    });

    it("reports zero when no judge call has failed", async () => {
      catEvalRepo.delete.mockResolvedValue({ affected: 0 });

      expect(await service.deleteFailedEvaluations()).toEqual({ deleted: 0 });
    });
  });
});
