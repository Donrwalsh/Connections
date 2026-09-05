import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DailyAutomationService } from "./daily-automation.service";
import { AutomationRunLog } from "./entities/automation-run-log.entity";
import { CategoryEvaluatorService } from "../strategy/category-evaluator.service";
import { FreeTierDispatchService } from "../free-tier-dispatch/free-tier-dispatch.service";
import { GoogleFreeDispatchService } from "../google-free-dispatch/google-free-dispatch.service";
import { GroqFreeDispatchService } from "../groq-free-dispatch/groq-free-dispatch.service";
import { OpenRouterFreeDispatchService } from "../openrouter-free-dispatch/openrouter-free-dispatch.service";
import { MistralFreeDispatchService } from "../mistral-free-dispatch/mistral-free-dispatch.service";
import { ModelMetadataRefreshService } from "../supported-model/model-metadata-refresh.service";

describe("DailyAutomationService", () => {
  let service: DailyAutomationService;
  let mockRunLogRepo: { upsert: jest.Mock; update: jest.Mock; findOne: jest.Mock };
  let mockCategoryEvaluatorService: { enqueuePending: jest.Mock };
  let mockFreeTierDispatchService: { getStatus: jest.Mock; start: jest.Mock };
  let mockGoogleFreeDispatchService: { getStatus: jest.Mock; start: jest.Mock };
  let mockGroqFreeDispatchService: { getStatus: jest.Mock; start: jest.Mock };
  let mockOpenRouterFreeDispatchService: { getStatus: jest.Mock; start: jest.Mock };
  let mockMistralFreeDispatchService: { getStatus: jest.Mock; start: jest.Mock };
  let mockModelMetadataRefreshService: { refreshAll: jest.Mock };

  const todayStamp = () => new Date().toISOString().slice(0, 10);

  beforeEach(async () => {
    mockRunLogRepo = {
      upsert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn(),
    };
    mockCategoryEvaluatorService = {
      enqueuePending: jest.fn().mockResolvedValue({ enqueued: 12, llmProposalIds: [] }),
    };
    mockFreeTierDispatchService = {
      getStatus: jest.fn().mockResolvedValue({ tier: "mini", active: false, thresholdPercent: null, startedAt: null }),
      start: jest.fn().mockResolvedValue({ tier: "mini", active: true, thresholdPercent: 80, startedAt: new Date() }),
    };
    mockGoogleFreeDispatchService = {
      getStatus: jest.fn().mockResolvedValue({ active: false, startedAt: null }),
      start: jest.fn().mockResolvedValue({ status: { active: true, startedAt: new Date() }, outcome: "started" }),
    };
    mockGroqFreeDispatchService = {
      getStatus: jest.fn().mockResolvedValue({ active: false, startedAt: null }),
      start: jest.fn().mockResolvedValue({ status: { active: true, startedAt: new Date() }, outcome: "started" }),
    };
    mockOpenRouterFreeDispatchService = {
      getStatus: jest
        .fn()
        .mockResolvedValue({ active: false, startedAt: null, callsToday: 0, dailyBudget: 50 }),
      start: jest.fn().mockResolvedValue({
        status: { active: true, startedAt: new Date(), callsToday: 0, dailyBudget: 50 },
        outcome: "started",
      }),
    };
    mockMistralFreeDispatchService = {
      getStatus: jest.fn().mockResolvedValue({ active: false, startedAt: null }),
      start: jest
        .fn()
        .mockResolvedValue({ status: { active: true, startedAt: new Date() }, outcome: "started" }),
    };
    mockModelMetadataRefreshService = {
      refreshAll: jest.fn().mockResolvedValue({ updated: 3, skipped: 1, errored: 0 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyAutomationService,
        { provide: getRepositoryToken(AutomationRunLog), useValue: mockRunLogRepo },
        { provide: CategoryEvaluatorService, useValue: mockCategoryEvaluatorService },
        { provide: FreeTierDispatchService, useValue: mockFreeTierDispatchService },
        { provide: GoogleFreeDispatchService, useValue: mockGoogleFreeDispatchService },
        { provide: GroqFreeDispatchService, useValue: mockGroqFreeDispatchService },
        { provide: OpenRouterFreeDispatchService, useValue: mockOpenRouterFreeDispatchService },
        { provide: MistralFreeDispatchService, useValue: mockMistralFreeDispatchService },
        { provide: ModelMetadataRefreshService, useValue: mockModelMetadataRefreshService },
      ],
    }).compile();

    service = module.get<DailyAutomationService>(DailyAutomationService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("run", () => {
    it("upserts today's row before running any leg", async () => {
      await service.run();

      expect(mockRunLogRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ date: todayStamp(), triggeredAt: expect.any(Date) }),
        ["date"],
      );
    });

    it("refreshes model metadata before running any dispatch leg", async () => {
      const order: string[] = [];
      mockModelMetadataRefreshService.refreshAll.mockImplementation(async () => {
        order.push("metadataRefresh");
        return { updated: 3, skipped: 1, errored: 0 };
      });
      mockCategoryEvaluatorService.enqueuePending.mockImplementation(async () => {
        order.push("judge");
        return { enqueued: 12, llmProposalIds: [] };
      });
      mockFreeTierDispatchService.start.mockImplementation(async () => {
        order.push("miniBurn");
        return { tier: "mini", active: true, thresholdPercent: 80, startedAt: new Date() };
      });
      mockGoogleFreeDispatchService.start.mockImplementation(async () => {
        order.push("googleBurn");
        return { status: { active: true, startedAt: new Date() }, outcome: "started" };
      });
      mockGroqFreeDispatchService.start.mockImplementation(async () => {
        order.push("groqBurn");
        return { status: { active: true, startedAt: new Date() }, outcome: "started" };
      });
      mockOpenRouterFreeDispatchService.start.mockImplementation(async () => {
        order.push("openRouterBurn");
        return {
          status: { active: true, startedAt: new Date(), callsToday: 0, dailyBudget: 50 },
          outcome: "started",
        };
      });
      mockMistralFreeDispatchService.start.mockImplementation(async () => {
        order.push("mistralBurn");
        return { status: { active: true, startedAt: new Date() }, outcome: "started" };
      });

      await service.run();

      expect(order).toEqual([
        "metadataRefresh",
        "judge",
        "miniBurn",
        "googleBurn",
        "groqBurn",
        "openRouterBurn",
        "mistralBurn",
      ]);
    });

    it("records the metadata-refresh leg's updated count on success", async () => {
      await service.run();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { metadataRefreshUpdated: 3, metadataRefreshError: null },
      );
    });

    it("records a metadata-refresh failure without throwing, and still runs the other legs", async () => {
      mockModelMetadataRefreshService.refreshAll.mockRejectedValueOnce(new Error("openrouter down"));

      await expect(service.run()).resolves.toBeUndefined();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { metadataRefreshUpdated: null, metadataRefreshError: "openrouter down" },
      );
      expect(mockCategoryEvaluatorService.enqueuePending).toHaveBeenCalled();
      expect(mockFreeTierDispatchService.start).toHaveBeenCalled();
      expect(mockGoogleFreeDispatchService.start).toHaveBeenCalled();
      expect(mockGroqFreeDispatchService.start).toHaveBeenCalled();
      expect(mockOpenRouterFreeDispatchService.start).toHaveBeenCalled();
    });

    it("records the judge leg's enqueued count on success", async () => {
      await service.run();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { judgeEnqueued: 12, judgeError: null },
      );
    });

    it("records a judge leg failure without throwing, and still runs the other legs", async () => {
      mockCategoryEvaluatorService.enqueuePending.mockRejectedValueOnce(new Error("db down"));

      await expect(service.run()).resolves.toBeUndefined();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { judgeEnqueued: null, judgeError: "db down" },
      );
      expect(mockFreeTierDispatchService.start).toHaveBeenCalled();
      expect(mockGoogleFreeDispatchService.start).toHaveBeenCalled();
      expect(mockGroqFreeDispatchService.start).toHaveBeenCalled();
      expect(mockOpenRouterFreeDispatchService.start).toHaveBeenCalled();
    });

    it("skips the judge leg but still runs every other leg when skipJudgeLeg is set", async () => {
      await service.run({ skipJudgeLeg: true });

      expect(mockCategoryEvaluatorService.enqueuePending).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).not.toHaveBeenCalledWith(
        { date: todayStamp() },
        expect.objectContaining({ judgeEnqueued: expect.anything() }),
      );
      expect(mockModelMetadataRefreshService.refreshAll).toHaveBeenCalled();
      expect(mockFreeTierDispatchService.start).toHaveBeenCalled();
      expect(mockGoogleFreeDispatchService.start).toHaveBeenCalled();
      expect(mockGroqFreeDispatchService.start).toHaveBeenCalled();
      expect(mockOpenRouterFreeDispatchService.start).toHaveBeenCalled();
    });

    it("runs the judge leg when skipJudgeLeg is absent or false", async () => {
      await service.run({ skipJudgeLeg: false });

      expect(mockCategoryEvaluatorService.enqueuePending).toHaveBeenCalledWith({ limit: 500 });
    });

    it("starts the mini burn at an 80% ceiling when no cycle is already running", async () => {
      await service.run();

      expect(mockFreeTierDispatchService.start).toHaveBeenCalledWith("mini", 80);
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { miniBurnOutcome: "started", miniBurnMessage: "started at 80%" },
      );
    });

    it("records alreadyActive for the mini leg without calling start, when a cycle is already running", async () => {
      mockFreeTierDispatchService.getStatus.mockResolvedValueOnce({
        tier: "mini",
        active: true,
        thresholdPercent: 90,
        startedAt: new Date(),
      });

      await service.run();

      expect(mockFreeTierDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { miniBurnOutcome: "alreadyActive", miniBurnMessage: "already running at 90%" },
      );
    });

    it("records an error for the mini leg when start throws, without crashing the run", async () => {
      mockFreeTierDispatchService.start.mockRejectedValueOnce(new BadRequestException("boom"));

      await expect(service.run()).resolves.toBeUndefined();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { miniBurnOutcome: "error", miniBurnMessage: "boom" },
      );
      expect(mockGoogleFreeDispatchService.start).toHaveBeenCalled();
    });

    it("starts the Google burn when no cycle is already running", async () => {
      await service.run();

      expect(mockGoogleFreeDispatchService.start).toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { googleBurnOutcome: "started", googleBurnMessage: "started" },
      );
    });

    it("records alreadyExhausted for the Google leg from start()'s own outcome", async () => {
      mockGoogleFreeDispatchService.start.mockResolvedValueOnce({
        status: { active: false, startedAt: null },
        outcome: "alreadyExhausted",
      });

      await service.run();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { googleBurnOutcome: "alreadyExhausted", googleBurnMessage: "every Google model is currently RPD-held" },
      );
    });

    it("records alreadyActive for the Google leg without calling start, when a cycle is already running", async () => {
      mockGoogleFreeDispatchService.getStatus.mockResolvedValueOnce({ active: true, startedAt: new Date() });

      await service.run();

      expect(mockGoogleFreeDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { googleBurnOutcome: "alreadyActive", googleBurnMessage: "already running" },
      );
    });

    it("starts the Groq burn when no cycle is already running", async () => {
      await service.run();

      expect(mockGroqFreeDispatchService.start).toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { groqBurnOutcome: "started", groqBurnMessage: "started" },
      );
    });

    it("records alreadyExhausted for the Groq leg from start()'s own outcome", async () => {
      mockGroqFreeDispatchService.start.mockResolvedValueOnce({
        status: { active: false, startedAt: null },
        outcome: "alreadyExhausted",
      });

      await service.run();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { groqBurnOutcome: "alreadyExhausted", groqBurnMessage: "every Groq model is currently RPD-held" },
      );
    });

    it("records alreadyActive for the Groq leg without calling start, when a cycle is already running", async () => {
      mockGroqFreeDispatchService.getStatus.mockResolvedValueOnce({ active: true, startedAt: new Date() });

      await service.run();

      expect(mockGroqFreeDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { groqBurnOutcome: "alreadyActive", groqBurnMessage: "already running" },
      );
    });

    it("records a Groq leg failure without throwing, and still lets the other legs run", async () => {
      mockGroqFreeDispatchService.start.mockRejectedValueOnce(new Error("groq down"));

      await expect(service.run()).resolves.toBeUndefined();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { groqBurnOutcome: "error", groqBurnMessage: "groq down" },
      );
    });

    it("starts the OpenRouter burn when no cycle is already running", async () => {
      await service.run();

      expect(mockOpenRouterFreeDispatchService.start).toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { openRouterBurnOutcome: "started", openRouterBurnMessage: "started" },
      );
    });

    it("records alreadyExhausted for the OpenRouter leg from start()'s own outcome", async () => {
      mockOpenRouterFreeDispatchService.start.mockResolvedValueOnce({
        status: { active: false, startedAt: null, callsToday: 50, dailyBudget: 50 },
        outcome: "alreadyExhausted",
      });

      await service.run();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        {
          openRouterBurnOutcome: "alreadyExhausted",
          openRouterBurnMessage: "OpenRouter daily budget spent or account held",
        },
      );
    });

    it("records alreadyActive for the OpenRouter leg without calling start", async () => {
      mockOpenRouterFreeDispatchService.getStatus.mockResolvedValueOnce({
        active: true,
        startedAt: new Date(),
        callsToday: 5,
        dailyBudget: 50,
      });

      await service.run();

      expect(mockOpenRouterFreeDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { openRouterBurnOutcome: "alreadyActive", openRouterBurnMessage: "already running" },
      );
    });

    it("records an OpenRouter leg failure without throwing, and still lets the other legs run", async () => {
      mockOpenRouterFreeDispatchService.start.mockRejectedValueOnce(new Error("openrouter down"));

      await expect(service.run()).resolves.toBeUndefined();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { openRouterBurnOutcome: "error", openRouterBurnMessage: "openrouter down" },
      );
    });

    it("starts the Mistral burn when no cycle is already running", async () => {
      await service.run();

      expect(mockMistralFreeDispatchService.start).toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { mistralBurnOutcome: "started", mistralBurnMessage: "started" },
      );
    });

    it("records alreadyExhausted for the Mistral leg from start()'s own outcome", async () => {
      mockMistralFreeDispatchService.start.mockResolvedValueOnce({
        status: { active: false, startedAt: null },
        outcome: "alreadyExhausted",
      });

      await service.run();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        {
          mistralBurnOutcome: "alreadyExhausted",
          mistralBurnMessage: "every Mistral model is currently held",
        },
      );
    });

    it("records alreadyActive for the Mistral leg without calling start", async () => {
      mockMistralFreeDispatchService.getStatus.mockResolvedValueOnce({
        active: true,
        startedAt: new Date(),
      });

      await service.run();

      expect(mockMistralFreeDispatchService.start).not.toHaveBeenCalled();
      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { mistralBurnOutcome: "alreadyActive", mistralBurnMessage: "already running" },
      );
    });

    it("records a Mistral leg failure without throwing, and still lets the other legs run", async () => {
      mockMistralFreeDispatchService.start.mockRejectedValueOnce(new Error("mistral down"));

      await expect(service.run()).resolves.toBeUndefined();

      expect(mockRunLogRepo.update).toHaveBeenCalledWith(
        { date: todayStamp() },
        { mistralBurnOutcome: "error", mistralBurnMessage: "mistral down" },
      );
    });
  });

  describe("getTodayStatus", () => {
    it("returns today's row", async () => {
      const row = { date: todayStamp(), triggeredAt: new Date() } as AutomationRunLog;
      mockRunLogRepo.findOne.mockResolvedValueOnce(row);

      const result = await service.getTodayStatus();

      expect(mockRunLogRepo.findOne).toHaveBeenCalledWith({ where: { date: todayStamp() } });
      expect(result).toBe(row);
    });

    it("returns null when nothing has run today", async () => {
      mockRunLogRepo.findOne.mockResolvedValueOnce(null);

      expect(await service.getTodayStatus()).toBeNull();
    });
  });
});
