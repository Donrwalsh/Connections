import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CategoryEvaluationCoverage } from "../../../data/benchmark/types";
import { CategoryJudgingWidget } from "../CategoryJudgingWidget";

function stubCoverage(coverage: CategoryEvaluationCoverage) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      if (String(url).includes("/category-evaluation/coverage")) {
        return Promise.resolve({ ok: true, json: async () => coverage });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CategoryJudgingWidget", () => {
  it("shows judged-vs-eligible and the pending count to dispatch", async () => {
    stubCoverage({ eligible: 50, judged: 42, pending: 8 });
    render(<CategoryJudgingWidget />);

    expect(await screen.findByText("42 / 50 judged")).toBeInTheDocument();
    expect(screen.getByText("8 to judge")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "84");
  });

  it("says everything is judged when nothing is pending", async () => {
    stubCoverage({ eligible: 12, judged: 12, pending: 0 });
    render(<CategoryJudgingWidget />);

    expect(await screen.findByText("All 12 judged")).toBeInTheDocument();
  });

  it("says there is nothing to judge when no guesses are eligible", async () => {
    stubCoverage({ eligible: 0, judged: 0, pending: 0 });
    render(<CategoryJudgingWidget />);

    expect(await screen.findByText("Nothing to judge yet")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("re-fetches coverage on an interval so a running dispatch drains visibly", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ eligible: 50, judged: 42, pending: 8 }) }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<CategoryJudgingWidget />);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("shows the auto-run line when an automation prop is given", async () => {
    stubCoverage({ eligible: 50, judged: 42, pending: 8 });

    render(
      <CategoryJudgingWidget
        automation={{
          message: "enqueued 8",
          lastRunAt: "2024-06-01T00:15:00.000Z",
          nextRunAt: "2024-06-02T00:15:00.000Z",
          isError: false,
        }}
      />,
    );

    expect(
      await screen.findByText("Auto-run: enqueued 8 (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM"),
    ).toBeInTheDocument();
  });

  it("omits the auto-run line when no automation prop is given", async () => {
    stubCoverage({ eligible: 12, judged: 12, pending: 0 });

    render(<CategoryJudgingWidget />);

    await screen.findByText("All 12 judged");
    expect(screen.queryByText(/Auto-run:/)).not.toBeInTheDocument();
  });
});
