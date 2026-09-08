import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { RecentActivityEvent } from "../../../data/benchmark/types";
import { RecentActivityTable } from "../RecentActivityTable";

function runEvent(overrides: Partial<RecentActivityEvent> = {}): RecentActivityEvent {
  return {
    kind: "run",
    id: 1,
    puzzleId: 42,
    puzzleDate: "2026-09-01",
    strategyName: "llm-groq",
    modelName: "openai/gpt-oss-20b",
    occurredAt: "2026-09-01T12:00:00.000Z",
    trialNumber: 1,
    status: "completed",
    ...overrides,
  } as RecentActivityEvent;
}

function renderTable(events: RecentActivityEvent[]) {
  return render(
    <MemoryRouter>
      <RecentActivityTable events={events} />
    </MemoryRouter>,
  );
}

describe("RecentActivityTable — provider pool badge", () => {
  it("shows the serving pool beside the model for an LLM run", () => {
    renderTable([runEvent()]);

    const row = screen.getByRole("link");
    expect(within(row).getByText("Groq")).toBeInTheDocument();
  });

  it("shows no pool badge for a non-LLM strategy", () => {
    renderTable([runEvent({ strategyName: "alphabetical", modelName: null })]);

    const row = screen.getByRole("link");
    expect(within(row).queryByText("Groq")).not.toBeInTheDocument();
    expect(within(row).queryByText("OpenAI")).not.toBeInTheDocument();
  });
});
