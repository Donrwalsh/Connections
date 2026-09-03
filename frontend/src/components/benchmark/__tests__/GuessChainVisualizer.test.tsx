import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuessChainVisualizer } from "../GuessChainVisualizer";
import type { StrategyRunDetail } from "../../../data/benchmark/types";

const baseDetail: Omit<StrategyRunDetail, "solvePrompts" | "guesses"> = {
  id: 12345,
  strategyName: "llm-openai",
  trialNumber: 1,
  status: "completed",
  modelName: "gpt-4o",
  contextWindow: 128_000,
  startedAt: "2025-01-01T00:00:00Z",
  finishedAt: "2025-01-01T00:00:05Z",
  solveDurationMs: null,
  guessCount: 2,
  meta: { total: 2, page: 1, limit: 200 },
};

const llmDetail: StrategyRunDetail = {
  ...baseDetail,
  guesses: [
    {
      sequenceNumber: 1,
      words: ["APPLE", "BANANA", "CHERRY", "DATE"],
      result: "success",
      guessedAt: "2025-01-01T00:00:01Z",
    },
  ],
  solvePrompts: [
    {
      id: 1,
      promptNumber: 1,
      promptType: "initialSolve",
      status: "parsed",
      rawResponseText: "### ANSWER\nAPPLE, BANANA, CHERRY, DATE",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      latencyMs: 1200,
      temperature: 0.2,
      createdAt: "2025-01-01T00:00:00Z",
      issueTags: [],
      reconstructedPrompt: "You are an expert solver...",
      errorName: null,
      errorMessage: null,
      statusCode: null,
      isRetryable: null,
      requestBody: null,
      responseBody: null,
      proposals: [
        {
          id: 1,
          words: ["APPLE", "BANANA", "CHERRY", "DATE"],
          category: "Fruit",
          status: "used",
          guess: { sequenceNumber: 1, result: "success", guessedAt: "2025-01-01T00:00:01Z" },
          categoryEvaluation: null,
        },
        {
          id: 2,
          words: ["EGG", "FIG", "GRAPE", "HONEY"],
          category: "Uncertain",
          status: "not_selected",
          guess: null,
          categoryEvaluation: null,
        },
      ],
    },
  ],
};

const plainDetail: StrategyRunDetail = {
  ...baseDetail,
  strategyName: "alphabetical",
  guesses: [
    {
      sequenceNumber: 1,
      words: ["APPLE", "BANANA", "CHERRY", "DATE"],
      result: "success",
      guessedAt: "2025-01-01T00:00:01Z",
    },
  ],
  solvePrompts: [],
};

function stubFetch(detail: StrategyRunDetail) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => detail,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GuessChainVisualizer", () => {
  it("surfaces the runId it is asked to visualize immediately, before the fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<GuessChainVisualizer runId={12345} />);

    expect(screen.getByRole("heading", { name: "Guess chain" })).toBeInTheDocument();
    expect(screen.getByText("#12345")).toBeInTheDocument();
  });

  it("labels the section with the run id", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<GuessChainVisualizer runId={99} />);

    expect(screen.getByLabelText("Guess chain for run 99")).toBeInTheDocument();
  });

  it("renders the LLM prompt/proposal chain, distinguishing used from unused proposals", async () => {
    stubFetch(llmDetail);

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("Initial solve")).toBeInTheDocument();
    expect(screen.getByText("Fruit")).toBeInTheDocument();
    expect(screen.getByText("Uncertain")).toBeInTheDocument();
    expect(screen.getByText("Correct")).toBeInTheDocument();
    expect(screen.getByText("Not submitted")).toBeInTheDocument();

    const usedItem = screen.getByText("Fruit").closest("li");
    const unusedItem = screen.getByText("Uncertain").closest("li");
    expect(usedItem).toHaveClass("bench-proposal--used");
    expect(unusedItem).toHaveClass("bench-proposal--unused");
  });

  it("exposes the reconstructed prompt and raw response behind disclosure widgets, each labeled with its own token count", async () => {
    stubFetch(llmDetail);

    render(<GuessChainVisualizer runId={12345} />);

    expect(
      await screen.findByText("Prompt sent to the model (100 tokens)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Raw response (50 tokens)")).toBeInTheDocument();
    expect(screen.getByText("You are an expert solver...")).toBeInTheDocument();
  });

  it("flags a step with a parentheticalStripped issue tag", async () => {
    stubFetch({
      ...llmDetail,
      solvePrompts: [{ ...llmDetail.solvePrompts[0]!, issueTags: ["parentheticalStripped"] }],
    });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("Parenthetical stripped")).toBeInTheDocument();
  });

  it("flags a step with a wordNotOnList issue tag", async () => {
    stubFetch({
      ...llmDetail,
      solvePrompts: [{ ...llmDetail.solvePrompts[0]!, issueTags: ["wordNotOnList"] }],
    });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("Hallucinated word")).toBeInTheDocument();
  });

  it("does not render an issue badge for a step with no issue tags", async () => {
    stubFetch(llmDetail);

    render(<GuessChainVisualizer runId={12345} />);

    await screen.findByText("Initial solve");
    expect(screen.queryByText("Parenthetical stripped")).not.toBeInTheDocument();
    expect(screen.queryByText("Hallucinated word")).not.toBeInTheDocument();
  });

  it("labels a callError row instead of rendering a blank status pill", async () => {
    stubFetch({
      ...llmDetail,
      solvePrompts: [
        {
          ...llmDetail.solvePrompts[0]!,
          status: "callError",
          rawResponseText: null,
          proposals: [],
        },
      ],
    });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("Call failed")).toBeInTheDocument();
  });

  it("shows the error message, status, and raw request/response for a callError row, instead of the empty-proposals message", async () => {
    stubFetch({
      ...llmDetail,
      solvePrompts: [
        {
          ...llmDetail.solvePrompts[0]!,
          status: "callError",
          rawResponseText: null,
          proposals: [],
          errorName: "AI_APICallError",
          errorMessage: "Rate limit exceeded",
          statusCode: 429,
          isRetryable: true,
          requestBody: { model: "gpt-4.1-nano" },
          responseBody: { error: { message: "Rate limit exceeded" } },
        },
      ],
    });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("Rate limit exceeded")).toBeInTheDocument();
    expect(screen.getByText("AI_APICallError · HTTP 429 · retryable")).toBeInTheDocument();
    expect(screen.getByText("Raw request sent to OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Raw response from OpenAI")).toBeInTheDocument();
    expect(screen.queryByText("No candidate groups parsed.")).not.toBeInTheDocument();
  });

  it("skips the raw request/response disclosures when a callError row has no detail captured", async () => {
    stubFetch({
      ...llmDetail,
      solvePrompts: [
        {
          ...llmDetail.solvePrompts[0]!,
          status: "callError",
          rawResponseText: null,
          proposals: [],
          errorMessage: "Request timed out",
        },
      ],
    });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("Request timed out")).toBeInTheDocument();
    expect(screen.queryByText("Raw request sent to OpenAI")).not.toBeInTheDocument();
    expect(screen.queryByText("Raw response from OpenAI")).not.toBeInTheDocument();
  });

  it("renders a category-judge verdict pill and collapsible diagnostics for a used, evaluated proposal", async () => {
    const user = userEvent.setup();
    const base = llmDetail.solvePrompts[0]!;
    stubFetch({
      ...llmDetail,
      solvePrompts: [
        {
          ...base,
          proposals: [
            {
              ...base.proposals[0]!,
              categoryEvaluation: {
                verdict: "lucky",
                status: "judged",
                proposedCategory: "Fruits",
                actualCategory: "___ COBBLER",
                rationale: "Right words, wrong reason.",
                judgeModel: "gpt-4.1-nano",
                judgeProvider: "openai",
                promptTokens: 90,
                completionTokens: 8,
                totalTokens: 98,
                latencyMs: 30,
                statusCode: null,
                errorName: null,
                errorMessage: null,
                requestBody: null,
                responseHeaders: null,
                responseBody: null,
                rawResponseText: '{"verdict":"lucky"}',
                evaluatedAt: "2026-08-27T00:00:00.000Z",
              },
            },
            { ...base.proposals[1]! },
          ],
        },
      ],
    });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("Category: lucky")).toBeInTheDocument();

    const usedItem = screen.getByText("Fruit").closest("li")!;
    expect(within(usedItem).getByText("Category: lucky")).toBeInTheDocument();

    await user.click(within(usedItem).getByText("Category judge"));
    expect(within(usedItem).getByText("Fruits")).toBeInTheDocument();
    expect(within(usedItem).getByText("___ COBBLER")).toBeInTheDocument();
    expect(within(usedItem).getByText("Right words, wrong reason.")).toBeInTheDocument();

    const unusedItem = screen.getByText("Uncertain").closest("li")!;
    expect(within(unusedItem).queryByText(/Category:/)).not.toBeInTheDocument();
    expect(within(unusedItem).queryByText("Category judge")).not.toBeInTheDocument();
  });

  it("renders the judge-failed pill and error line for a used proposal whose category judge call errored", async () => {
    const user = userEvent.setup();
    const base = llmDetail.solvePrompts[0]!;
    stubFetch({
      ...llmDetail,
      solvePrompts: [
        {
          ...base,
          proposals: [
            {
              ...base.proposals[0]!,
              categoryEvaluation: {
                verdict: null,
                status: "callError",
                proposedCategory: "Fruits",
                actualCategory: "___ COBBLER",
                rationale: null,
                judgeModel: "gpt-4.1-nano",
                judgeProvider: "openai",
                promptTokens: null,
                completionTokens: null,
                totalTokens: null,
                latencyMs: null,
                statusCode: 502,
                errorName: "APICallError",
                errorMessage: "upstream 502",
                requestBody: null,
                responseHeaders: null,
                responseBody: null,
                rawResponseText: null,
                evaluatedAt: "2026-08-27T00:00:00.000Z",
              },
            },
            { ...base.proposals[1]! },
          ],
        },
      ],
    });

    render(<GuessChainVisualizer runId={12345} />);

    const usedItem = (await screen.findByText("Fruit")).closest("li")!;
    expect(within(usedItem).getByText(/judge failed/i)).toBeInTheDocument();

    const summary = within(usedItem).getByText("Category judge");
    expect(summary).toBeInTheDocument();
    await user.click(summary);

    expect(within(usedItem).getByText("APICallError: upstream 502")).toBeInTheDocument();
    expect(within(usedItem).queryByText("Judge request")).not.toBeInTheDocument();
    expect(within(usedItem).queryByText("Judge response headers")).not.toBeInTheDocument();
    expect(within(usedItem).queryByText("Judge response body")).not.toBeInTheDocument();
    expect(within(usedItem).queryByText("Judge raw output")).not.toBeInTheDocument();
  });

  it("falls back to a plain guess list for strategies with no solve-prompt chain", async () => {
    stubFetch(plainDetail);

    render(<GuessChainVisualizer runId={12345} />);

    const guessList = await screen.findByText("APPLE, BANANA, CHERRY, DATE");
    expect(guessList).toBeInTheDocument();
    expect(screen.queryByText("Initial solve")).not.toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("boom")).toBeInTheDocument();
  });

  it("shows an empty state when a run has no guesses at all", async () => {
    stubFetch({ ...plainDetail, guesses: [] });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByText("No guesses recorded for this run.")).toBeInTheDocument();
  });

  it("shows a 'Delete this run' button only when the run's status is 'error'", async () => {
    stubFetch({ ...plainDetail, status: "error" });

    render(<GuessChainVisualizer runId={12345} />);

    expect(await screen.findByRole("button", { name: "Delete this run" })).toBeInTheDocument();
  });

  it("does not show the delete button for a non-error status", async () => {
    stubFetch({ ...plainDetail, status: "completed" });

    render(<GuessChainVisualizer runId={12345} />);

    await screen.findByText("APPLE, BANANA, CHERRY, DATE");
    expect(screen.queryByRole("button", { name: "Delete this run" })).not.toBeInTheDocument();
  });

  it("opens the delete-run modal when the delete button is clicked", async () => {
    const user = userEvent.setup();
    stubFetch({ ...plainDetail, status: "error" });

    render(<GuessChainVisualizer runId={12345} />);

    await user.click(await screen.findByRole("button", { name: "Delete this run" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /12345/ })).toBeInTheDocument();
  });
});
