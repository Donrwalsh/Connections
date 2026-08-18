import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FreeTierBudgetWidget } from "../FreeTierBudgetWidget";
import type { FreeTierUsage } from "../../../data/benchmark/types";

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

function stubFetch(usage: FreeTierUsage) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => usage }));
}

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("shows a tier-specific error message when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    render(<FreeTierBudgetWidget tier="mini" />);

    expect(screen.getByText("Mini & nano daily tokens")).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load token usage: boom")).toBeInTheDocument();
  });
});
