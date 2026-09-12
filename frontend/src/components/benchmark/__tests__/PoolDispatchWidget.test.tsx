import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PoolDispatchWidget } from "../PoolDispatchWidget";
import { providerPoolById, type ProviderPoolId } from "../../../data/benchmark/providerPools";
import type { PoolDispatchStatus } from "../../../data/benchmark/types";

const FREE_TIER_POOL_IDS: ProviderPoolId[] = ["google", "groq", "openrouter", "mistral", "sambanova"];

function stubStatus(poolId: ProviderPoolId, status: PoolDispatchStatus) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      if (String(url).includes(`/dispatch/pool/${poolId}`)) {
        return Promise.resolve({ ok: true, json: async () => status });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// One hard test per pool catches "works for 4 of 5" bugs that five
// separately-maintained per-provider test files couldn't — same behaviour,
// exercised once per config row instead of once per hand-copied file.
describe.each(FREE_TIER_POOL_IDS)("PoolDispatchWidget (%s)", (poolId) => {
  const pool = providerPoolById(poolId);
  const title = `${pool.label} daily quota`;

  it("shows a loading state before the fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<PoolDispatchWidget pool={pool} />);

    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the active pill and dispatching copy when a cycle is running", async () => {
    stubStatus(poolId, { active: true, startedAt: "2024-06-01T00:15:00.000Z" });

    render(<PoolDispatchWidget pool={pool} />);

    expect(await screen.findByText("Auto-dispatch active")).toBeInTheDocument();
    expect(screen.getByText("Dispatching trials against unrun puzzles.")).toBeInTheDocument();
  });

  it("shows no pill and inactive copy when no cycle is running", async () => {
    stubStatus(poolId, { active: false, startedAt: null });

    render(<PoolDispatchWidget pool={pool} />);

    await screen.findByText("Not currently dispatching.");
    expect(screen.queryByText("Auto-dispatch active")).not.toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    render(<PoolDispatchWidget pool={pool} />);

    expect(
      await screen.findByText(`Couldn't load ${pool.label} dispatch status: boom`),
    ).toBeInTheDocument();
  });

  it("shows the auto-run line when an automation prop is given", async () => {
    stubStatus(poolId, { active: false, startedAt: null });

    render(
      <PoolDispatchWidget
        pool={pool}
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

  it("shows no Disable button when no cycle is running", async () => {
    stubStatus(poolId, { active: false, startedAt: null });

    render(<PoolDispatchWidget pool={pool} />);

    await screen.findByText("Not currently dispatching.");
    expect(screen.queryByRole("button", { name: /Disable/ })).not.toBeInTheDocument();
  });

  it("disables the dispatch cycle and hides the pill once stopped", async () => {
    const user = userEvent.setup();
    let status: PoolDispatchStatus = { active: true, startedAt: "2024-06-01T00:15:00.000Z" };
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      if (String(url).includes(`/dispatch/pool/${poolId}`)) {
        if (init?.method === "DELETE") {
          status = { active: false, startedAt: null };
          return Promise.resolve({ ok: true, json: async () => status });
        }
        return Promise.resolve({ ok: true, json: async () => status });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PoolDispatchWidget pool={pool} />);

    const disableButton = await screen.findByRole("button", { name: "Disable" });
    await user.click(disableButton);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/dispatch/pool/${poolId}`),
      expect.objectContaining({ method: "DELETE" }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Auto-dispatch active")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Disable/ })).not.toBeInTheDocument();
    });
  });

  it("shows an error and re-enables the button when disabling fails", async () => {
    const user = userEvent.setup();
    const activeStatus: PoolDispatchStatus = { active: true, startedAt: "2024-06-01T00:15:00.000Z" };
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes(`/dispatch/pool/${poolId}`) && init?.method === "DELETE") {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ message: "boom" }) });
      }
      if (href.includes(`/dispatch/pool/${poolId}`)) {
        return Promise.resolve({ ok: true, json: async () => activeStatus });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PoolDispatchWidget pool={pool} />);

    const disableButton = await screen.findByRole("button", { name: "Disable" });
    await user.click(disableButton);

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });
});

describe("PoolDispatchWidget (account-budget pool)", () => {
  const pool = providerPoolById("openrouter");

  it("renders the calls-today / budget line from the status payload", async () => {
    stubStatus("openrouter", { active: true, startedAt: null, callsToday: 18, dailyBudget: 50 });

    render(<PoolDispatchWidget pool={pool} />);

    expect(await screen.findByText("18 / 50 calls today")).toBeInTheDocument();
  });
});

describe("PoolDispatchWidget (non-account-budget pool)", () => {
  const pool = providerPoolById("google");

  it("renders no calls/budget line when the status has none", async () => {
    stubStatus("google", { active: true, startedAt: null });

    render(<PoolDispatchWidget pool={pool} />);

    await screen.findByText("Auto-dispatch active");
    expect(screen.queryByText(/calls today/)).not.toBeInTheDocument();
  });
});
