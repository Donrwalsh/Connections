import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeTierBudgetWidget } from "../FreeTierBudgetWidget";
import type { FreeTierDispatchStatus, FreeTierUsage } from "../../../data/benchmark/types";

const flagshipUsage: FreeTierUsage = {
  tier: "flagship",
  label: "Flagship models",
  usedTokens: 12_000,
  dailyLimitTokens: 250_000,
  remainingTokens: 238_000,
  models: ["gpt-5.4", "gpt-4.1", "gpt-4o", "o1", "o3"],
};

const miniUsage: FreeTierUsage = {
  tier: "mini",
  label: "Mini & nano models",
  usedTokens: 400_000,
  dailyLimitTokens: 2_500_000,
  remainingTokens: 2_100_000,
  models: ["gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o-mini", "o3-mini", "o4-mini", "gpt-5-nano"],
};

const inactiveDispatch: FreeTierDispatchStatus = {
  tier: "mini",
  active: false,
  thresholdPercent: null,
  startedAt: null,
};

const activeDispatch: FreeTierDispatchStatus = {
  tier: "mini",
  active: true,
  thresholdPercent: 90,
  startedAt: "2024-01-01T00:00:00Z",
};

function stubFetch(usage: FreeTierUsage, dispatchStatus: FreeTierDispatchStatus = inactiveDispatch) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      if (String(url).includes("/dispatch/free-tier/")) {
        return Promise.resolve({ ok: true, json: async () => dispatchStatus });
      }
      return Promise.resolve({ ok: true, json: async () => usage });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("FreeTierBudgetWidget", () => {
  it("shows a tier-specific loading state before the fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<FreeTierBudgetWidget tier="flagship" />);

    expect(screen.getByText("Flagship daily tokens")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("requests the flagship tier's usage from its own endpoint", () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<FreeTierBudgetWidget tier="flagship" />);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/strategy/free-tier-usage/flagship"),
      expect.anything(),
    );
  });

  it("requests the mini tier's usage from its own endpoint", () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<FreeTierBudgetWidget tier="mini" />);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/strategy/free-tier-usage/mini"),
      expect.anything(),
    );
  });

  it("renders the flagship tier's title and used/limit/remaining figures", async () => {
    stubFetch(flagshipUsage);

    render(<FreeTierBudgetWidget tier="flagship" />);

    expect(await screen.findByText("12,000 / 250,000 used")).toBeInTheDocument();
    expect(screen.getByText("Flagship daily tokens")).toBeInTheDocument();
    expect(screen.getByText("238,000 tokens remaining today")).toBeInTheDocument();
  });

  it("renders the mini tier's title and used/limit/remaining figures", async () => {
    stubFetch(miniUsage);

    render(<FreeTierBudgetWidget tier="mini" />);

    expect(await screen.findByText("400,000 / 2,500,000 used")).toBeInTheDocument();
    expect(screen.getByText("Mini & nano daily tokens")).toBeInTheDocument();
    expect(screen.getByText("2,100,000 tokens remaining today")).toBeInTheDocument();
  });

  it("does not apply the warning tint under the threshold", async () => {
    stubFetch(flagshipUsage);

    render(<FreeTierBudgetWidget tier="flagship" />);

    const bar = await screen.findByRole("progressbar");
    expect(bar.firstElementChild).not.toHaveClass("bench-free-tier__bar-fill--warning");
  });

  it("applies the warning tint once usage crosses 90% of the daily limit", async () => {
    stubFetch({ ...flagshipUsage, usedTokens: 230_000, remainingTokens: 20_000 });

    render(<FreeTierBudgetWidget tier="flagship" />);

    const bar = await screen.findByRole("progressbar");
    expect(bar.firstElementChild).toHaveClass("bench-free-tier__bar-fill--warning");
  });

  it("clamps the bar at 100% when usage exceeds the daily limit", async () => {
    stubFetch({ ...flagshipUsage, usedTokens: 300_000, remainingTokens: 0 });

    render(<FreeTierBudgetWidget tier="flagship" />);

    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
  });

  it("shows the total spent on trials so far when spentUsd is given", async () => {
    stubFetch(flagshipUsage);

    render(<FreeTierBudgetWidget tier="flagship" spentUsd={12.3456} />);

    await screen.findByText("238,000 tokens remaining today");
    expect(screen.getByText("$12.35")).toBeInTheDocument();
    expect(screen.getByText("spent on trials so far")).toBeInTheDocument();
  });

  it("renders a small spend figure with extra precision, matching the leaderboard's cost formatting", async () => {
    stubFetch(flagshipUsage);

    render(<FreeTierBudgetWidget tier="flagship" spentUsd={0.0057} />);

    expect(await screen.findByText("$0.0057")).toBeInTheDocument();
  });

  it("omits the spend line entirely when spentUsd hasn't loaded yet", async () => {
    stubFetch(flagshipUsage);

    render(<FreeTierBudgetWidget tier="flagship" />);

    await screen.findByText("238,000 tokens remaining today");
    expect(screen.queryByText(/spent on trials so far/)).not.toBeInTheDocument();
  });

  it("shows a tier-specific error message when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    render(<FreeTierBudgetWidget tier="mini" />);

    expect(screen.getByText("Mini & nano daily tokens")).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load token usage: boom")).toBeInTheDocument();
  });

  it("checks dispatch status for the mini tier", () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<FreeTierBudgetWidget tier="mini" />);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/dispatch/free-tier/mini"),
      expect.anything(),
    );
  });

  it("checks dispatch status for the flagship tier too — both tiers are dispatchable", () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);

    render(<FreeTierBudgetWidget tier="flagship" />);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/dispatch/free-tier/flagship"),
      expect.anything(),
    );
  });

  it("shows the auto-dispatch pill with its threshold when a cycle is active", async () => {
    stubFetch(miniUsage, activeDispatch);

    render(<FreeTierBudgetWidget tier="mini" />);

    expect(await screen.findByText("Auto-dispatch active · 90%")).toBeInTheDocument();
  });

  it("shows no auto-dispatch pill when no cycle is running", async () => {
    stubFetch(miniUsage, inactiveDispatch);

    render(<FreeTierBudgetWidget tier="mini" />);

    await screen.findByText("400,000 / 2,500,000 used");
    expect(screen.queryByText(/Auto-dispatch active/)).not.toBeInTheDocument();
  });

  it("re-checks dispatch status periodically, picking up a cycle that stopped since the last check", async () => {
    vi.useFakeTimers();
    let dispatchStatus = activeDispatch;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown) => {
        if (String(url).includes("/dispatch/free-tier/")) {
          return Promise.resolve({ ok: true, json: async () => dispatchStatus });
        }
        return Promise.resolve({ ok: true, json: async () => miniUsage });
      }),
    );

    render(<FreeTierBudgetWidget tier="mini" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("Auto-dispatch active · 90%")).toBeInTheDocument();

    dispatchStatus = inactiveDispatch;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.queryByText(/Auto-dispatch active/)).not.toBeInTheDocument();
  });

  it("shows no Disable button when no cycle is running", async () => {
    stubFetch(miniUsage, inactiveDispatch);

    render(<FreeTierBudgetWidget tier="mini" />);

    await screen.findByText("400,000 / 2,500,000 used");
    expect(screen.queryByRole("button", { name: /Disable/ })).not.toBeInTheDocument();
  });

  it("disables the tier's dispatch cycle and hides the pill once stopped", async () => {
    const user = userEvent.setup();
    let dispatchStatus: FreeTierDispatchStatus = activeDispatch;
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/dispatch/free-tier/")) {
        if (init?.method === "DELETE") {
          dispatchStatus = inactiveDispatch;
          return Promise.resolve({ ok: true, json: async () => dispatchStatus });
        }
        return Promise.resolve({ ok: true, json: async () => dispatchStatus });
      }
      return Promise.resolve({ ok: true, json: async () => miniUsage });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<FreeTierBudgetWidget tier="mini" />);

    const disableButton = await screen.findByRole("button", { name: "Disable" });
    await user.click(disableButton);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/dispatch/free-tier/mini"),
      expect.objectContaining({ method: "DELETE" }),
    );
    // The mock resolves immediately, so the transient "Disabling…" state
    // isn't reliably observable here — assert the settled end state
    // instead: the pill and button both gone once the cycle is confirmed
    // stopped.
    await waitFor(() => {
      expect(screen.queryByText(/Auto-dispatch active/)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Disable/ })).not.toBeInTheDocument();
    });
  });

  it("shows an error and re-enables the button when disabling fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/dispatch/free-tier/") && init?.method === "DELETE") {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ message: "boom" }) });
      }
      if (href.includes("/dispatch/free-tier/")) {
        return Promise.resolve({ ok: true, json: async () => activeDispatch });
      }
      return Promise.resolve({ ok: true, json: async () => miniUsage });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<FreeTierBudgetWidget tier="mini" />);

    const disableButton = await screen.findByRole("button", { name: "Disable" });
    await user.click(disableButton);

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });

  it("refetches dispatch status immediately when refreshSignal changes", async () => {
    let dispatchStatus = inactiveDispatch;
    const fetchMock = vi.fn((url: unknown) => {
      if (String(url).includes("/dispatch/free-tier/")) {
        return Promise.resolve({ ok: true, json: async () => dispatchStatus });
      }
      return Promise.resolve({ ok: true, json: async () => miniUsage });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<FreeTierBudgetWidget tier="mini" refreshSignal={0} />);
    await screen.findByText("400,000 / 2,500,000 used");
    expect(screen.queryByText(/Auto-dispatch active/)).not.toBeInTheDocument();

    // Simulates FreeTierDispatchModal starting a cycle elsewhere on the
    // page — this widget wouldn't otherwise know until its next 30s poll.
    dispatchStatus = activeDispatch;
    rerender(<FreeTierBudgetWidget tier="mini" refreshSignal={1} />);

    expect(await screen.findByText("Auto-dispatch active · 90%")).toBeInTheDocument();
  });
});
