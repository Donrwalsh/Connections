import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../data/benchmark/types";
import { RunsTable } from "../RunsTable";

const runs: RunRecord[] = [
  {
    runId: 1,
    runNumber: 1,
    status: "completed",
    totalSteps: 4,
    durationMs: 2_500,
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: "2025-01-01T00:00:02Z",
    modelName: null,
  },
  {
    runId: 2,
    runNumber: 2,
    status: "running",
    totalSteps: null,
    durationMs: null,
    startedAt: "2025-01-01T00:01:00Z",
    finishedAt: null,
    modelName: null,
  },
];

describe("RunsTable", () => {
  it("renders one row per run with outcome, steps and duration", () => {
    render(<RunsTable runs={runs} selectedRunId={null} onSelectRun={vi.fn()} />);

    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("2.5s")).toBeInTheDocument();
  });

  it("renders an em dash for unfinished metrics", () => {
    render(<RunsTable runs={runs} selectedRunId={null} onSelectRun={vi.fn()} />);

    const runningRow = screen.getByRole("button", { name: /Running/ });
    expect(runningRow.textContent).toContain("—");
  });

  it("selects a run when clicked", async () => {
    const user = userEvent.setup();
    const onSelectRun = vi.fn();
    render(<RunsTable runs={runs} selectedRunId={null} onSelectRun={onSelectRun} />);

    await user.click(screen.getByRole("button", { name: /#1/ }));

    expect(onSelectRun).toHaveBeenCalledWith(1);
  });

  it("marks the selected run row", () => {
    render(<RunsTable runs={runs} selectedRunId={2} onSelectRun={vi.fn()} />);

    const selectedRow = screen.getByRole("button", { name: /#2/ });
    expect(selectedRow).toHaveAttribute("aria-pressed", "true");
  });
});
