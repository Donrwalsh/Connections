import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterDispatchWidget } from "../OpenRouterDispatchWidget";
import type { OpenRouterDispatchStatus } from "../../../data/benchmark/types";

function stubStatus(status: OpenRouterDispatchStatus) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      if (String(url).includes("/dispatch/openrouter")) {
        return Promise.resolve({ ok: true, json: async () => status });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouterDispatchWidget", () => {
  it("shows a loading state before the fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<OpenRouterDispatchWidget />);

    expect(screen.getByText("OpenRouter daily quota")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the active pill and dispatching copy when a cycle is running", async () => {
    stubStatus({ active: true, startedAt: "2024-06-01T00:15:00.000Z", callsToday: 4, dailyBudget: 50 });

    render(<OpenRouterDispatchWidget />);

    expect(await screen.findByText("Auto-dispatch active")).toBeInTheDocument();
    expect(screen.getByText("Dispatching trials against unrun puzzles.")).toBeInTheDocument();
  });

  it("renders the calls-today / budget line from the status payload", async () => {
    stubStatus({ active: true, startedAt: null, callsToday: 18, dailyBudget: 50 });

    render(<OpenRouterDispatchWidget />);

    expect(await screen.findByText("18 / 50 calls today")).toBeInTheDocument();
  });

  it("shows no pill and inactive copy when no cycle is running", async () => {
    stubStatus({ active: false, startedAt: null, callsToday: 0, dailyBudget: 50 });

    render(<OpenRouterDispatchWidget />);

    await screen.findByText("Not currently dispatching.");
    expect(screen.queryByText("Auto-dispatch active")).not.toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    render(<OpenRouterDispatchWidget />);

    expect(
      await screen.findByText("Couldn't load OpenRouter dispatch status: boom"),
    ).toBeInTheDocument();
  });

  it("shows the auto-run line when an automation prop is given", async () => {
    stubStatus({ active: false, startedAt: null, callsToday: 0, dailyBudget: 50 });

    render(
      <OpenRouterDispatchWidget
        automation={{
          message: "started",
          lastRunAt: "2024-06-01T00:15:00.000Z",
          nextRunAt: "2024-06-02T00:15:00.000Z",
          isError: false,
        }}
      />,
    );

    expect(
      await screen.findByText("Auto-run: started (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM"),
    ).toBeInTheDocument();
  });

  it("disables the OpenRouter dispatch cycle and hides the pill once stopped", async () => {
    const user = userEvent.setup();
    let status: OpenRouterDispatchStatus = {
      active: true,
      startedAt: "2024-06-01T00:15:00.000Z",
      callsToday: 4,
      dailyBudget: 50,
    };
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      if (String(url).includes("/dispatch/openrouter")) {
        if (init?.method === "DELETE") {
          status = { active: false, startedAt: null, callsToday: 4, dailyBudget: 50 };
          return Promise.resolve({ ok: true, json: async () => status });
        }
        return Promise.resolve({ ok: true, json: async () => status });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<OpenRouterDispatchWidget />);

    const disableButton = await screen.findByRole("button", { name: "Disable" });
    await user.click(disableButton);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/dispatch/openrouter"),
      expect.objectContaining({ method: "DELETE" }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Auto-dispatch active")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Disable/ })).not.toBeInTheDocument();
    });
  });
});
