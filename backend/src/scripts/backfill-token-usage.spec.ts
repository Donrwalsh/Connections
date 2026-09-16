import { Logger } from "@nestjs/common";
import type { DataSource } from "typeorm";
import { backfillTable, parseUsageFromResponseBody, TokenRow } from "./backfill-token-usage";

describe("parseUsageFromResponseBody", () => {
  it("parses the Responses API shape (input_tokens/output_tokens/output_tokens_details)", () => {
    const responseBody = {
      usage: {
        input_tokens: 2134,
        output_tokens: 16162,
        total_tokens: 18296,
        output_tokens_details: { reasoning_tokens: 16000 },
      },
    };

    expect(parseUsageFromResponseBody(responseBody)).toEqual({
      promptTokens: 2134,
      completionTokens: 16162,
      totalTokens: 18296,
      reasoningTokens: 16000,
    });
  });

  it("parses the Chat Completions shape (prompt_tokens/completion_tokens/completion_tokens_details)", () => {
    const responseBody = {
      usage: {
        prompt_tokens: 500,
        completion_tokens: 1200,
        total_tokens: 1700,
        completion_tokens_details: { reasoning_tokens: 900 },
      },
    };

    expect(parseUsageFromResponseBody(responseBody)).toEqual({
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: 900,
    });
  });

  it("returns null reasoningTokens when the shape has no reasoning breakdown at all", () => {
    const responseBody = {
      usage: { prompt_tokens: 500, completion_tokens: 1200, total_tokens: 1700 },
    };

    expect(parseUsageFromResponseBody(responseBody)).toEqual({
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: null,
    });
  });

  it("returns null when responseBody has no usage object at all", () => {
    expect(parseUsageFromResponseBody({ error: "some gateway error page" })).toBeNull();
    expect(parseUsageFromResponseBody(null)).toBeNull();
    expect(parseUsageFromResponseBody("a raw string body")).toBeNull();
  });
});

describe("backfillTable", () => {
  // Lightweight fake matching just the Repository<TokenRow> methods
  // backfillTable calls — this script isn't a NestJS service, so there's no
  // TestingModule/getRepositoryToken to lean on the way
  // free-tier-usage.service.spec.ts does; a plain fake object is the
  // equivalent for this file.
  function makeFakeRepo(rows: TokenRow[]) {
    return {
      find: jest.fn().mockResolvedValue(rows),
      update: jest.fn().mockResolvedValue(undefined),
    };
  }

  function makeFakeDataSource(repo: ReturnType<typeof makeFakeRepo>) {
    return { getRepository: jest.fn().mockReturnValue(repo) } as unknown as DataSource;
  }

  const chatCompletionsResponseBody = {
    usage: {
      prompt_tokens: 500,
      completion_tokens: 1200,
      total_tokens: 1700,
      completion_tokens_details: { reasoning_tokens: 900 },
    },
  };

  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("fills only the null column on a row where the other three are already correct, leaving them untouched", async () => {
    const row: TokenRow = {
      id: 1,
      responseBody: chatCompletionsResponseBody,
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: null,
    };
    const repo = makeFakeRepo([row]);
    const dataSource = makeFakeDataSource(repo);

    await backfillTable(dataSource, class {} as new () => TokenRow, "TestTable", false);

    expect(repo.update).toHaveBeenCalledTimes(1);
    expect(repo.update).toHaveBeenCalledWith(1, {
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: 900,
    });
  });

  it("logs a warning and keeps the stored value when a recomputed value disagrees with an existing non-null column", async () => {
    const row: TokenRow = {
      id: 2,
      responseBody: chatCompletionsResponseBody,
      // Stored totalTokens disagrees with the responseBody's 1700.
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 999,
      reasoningTokens: null,
    };
    const repo = makeFakeRepo([row]);
    const dataSource = makeFakeDataSource(repo);

    await backfillTable(dataSource, class {} as new () => TokenRow, "TestTable", false);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Row 2: stored totalTokens=999 disagrees with recomputed totalTokens=1700"),
    );
    // Only reasoningTokens (the null column) should change; the disagreeing
    // totalTokens value must survive untouched.
    expect(repo.update).toHaveBeenCalledWith(2, {
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 999,
      reasoningTokens: 900,
    });
  });

  it("makes no writes in --dry-run mode, even when a row would otherwise change", async () => {
    const row: TokenRow = {
      id: 3,
      responseBody: chatCompletionsResponseBody,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      reasoningTokens: null,
    };
    const repo = makeFakeRepo([row]);
    const dataSource = makeFakeDataSource(repo);

    await backfillTable(dataSource, class {} as new () => TokenRow, "TestTable", true);

    expect(repo.update).not.toHaveBeenCalled();
  });

  it("still logs a disagreement warning in --dry-run mode", async () => {
    const row: TokenRow = {
      id: 4,
      responseBody: chatCompletionsResponseBody,
      promptTokens: 1,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: 900,
    };
    const repo = makeFakeRepo([row]);
    const dataSource = makeFakeDataSource(repo);

    await backfillTable(dataSource, class {} as new () => TokenRow, "TestTable", true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Row 4: stored promptTokens=1 disagrees with recomputed promptTokens=500"),
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it("does not count or write a row as updated when every recomputed value already matches or is null", async () => {
    const row: TokenRow = {
      id: 5,
      responseBody: chatCompletionsResponseBody,
      promptTokens: 500,
      completionTokens: 1200,
      totalTokens: 1700,
      reasoningTokens: 900,
    };
    const repo = makeFakeRepo([row]);
    const dataSource = makeFakeDataSource(repo);

    await backfillTable(dataSource, class {} as new () => TokenRow, "TestTable", false);

    expect(repo.update).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Updated 0 of 1 row(s)."));
  });
});
