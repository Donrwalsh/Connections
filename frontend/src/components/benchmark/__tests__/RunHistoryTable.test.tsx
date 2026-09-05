import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { RunHistoryRow } from "../../../data/benchmark/types";
import { RunHistoryTable } from "../RunHistoryTable";

function makeRow(overrides: Partial<RunHistoryRow> = {}): RunHistoryRow {
  return {
    id: 1,
    puzzleId: 235,
    puzzleDate: "2026-01-01",
    strategyName: "llm-groq",
    modelName: "qwen/qwen3.6-27b",
    trialNumber: 1,
    status: "completed",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:05Z",
    guessCount: 4,
    tokenCostUsd: null,
    issueCount: 0,
    categoryCorrect: 0,
    categoryPartial: 0,
    categoryLucky: 0,
    ...overrides,
  } as RunHistoryRow;
}

/** Renders the captured :strategyId param as plain text, so a test can
 * assert on the *decoded* value React Router hands back — proving the
 * route actually matched (not just that some URL string was produced). */
function ParamProbe() {
  const { strategyId, puzzleId } = useParams();
  return <div data-testid="probe">{`${strategyId}::${puzzleId}`}</div>;
}

describe("RunHistoryTable", () => {
  // Regression: Groq model ids follow a "provider/model" convention
  // (e.g. "qwen/qwen3.6-27b") and contain a literal "/" — unlike every
  // OpenAI/Google model id this route param design was built around (see
  // StrategyMeta's doc comment). An un-encoded link splits into an extra
  // path segment that /leaderboard/:strategyId/:puzzleId can't match at
  // all, producing React Router's "No routes matched" error instead of
  // navigating anywhere.
  it("navigates to a correctly-encoded URL for a model id containing a slash", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/from"]}>
        <Routes>
          <Route
            path="/from"
            element={
              <RunHistoryTable
                strategyId="qwen/qwen3.6-27b"
                rows={[makeRow()]}
                sortBy="puzzleDate"
                sortDir="desc"
                onSortChange={vi.fn()}
                showTokenCost
                status={null}
                onStatusChange={vi.fn()}
              />
            }
          />
          <Route path="/leaderboard/:strategyId/:puzzleId" element={<ParamProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("link", { name: /View runs for puzzle #235/ }));

    expect(await screen.findByTestId("probe")).toHaveTextContent("qwen/qwen3.6-27b::235");
  });
});
