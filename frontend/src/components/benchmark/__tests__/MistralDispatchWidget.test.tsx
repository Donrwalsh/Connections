import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MistralDispatchWidget } from "../MistralDispatchWidget";
import type { MistralDispatchStatus } from "../../../data/benchmark/types";

function stubStatus(status: MistralDispatchStatus) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      if (String(url).includes("/dispatch/mistral")) {
        return Promise.resolve({ ok: true, json: async () => status });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MistralDispatchWidget", () => {
  it("shows a loading state before the fetch resolves", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

    render(<MistralDispatchWidget />);

    expect(screen.getByText("Mistral free tier")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows the active pill and dispatching copy when a cycle is running", async () => {
    stubStatus({ active: true, startedAt: "2024-06-01T00:15:00.000Z" });

    render(<MistralDispatchWidget />);

    expect(await screen.findByText("Auto-dispatch active")).toBeInTheDocument();
    expect(screen.getByText("Dispatching trials against unrun puzzles.")).toBeInTheDocument();
  });

  it("shows no pill and inactive copy when no cycle is running", async () => {
    stubStatus({ active: false, startedAt: null });

    render(<MistralDispatchWidget />);

    await screen.findByText("Not currently dispatching.");
    expect(screen.queryByText("Auto-dispatch active")).not.toBeInTheDocument();
  });

  it("shows an error message when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));

    render(<MistralDispatchWidget />);

    expect(
      await screen.findByText("Couldn't load Mistral dispatch status: boom"),
    ).toBeInTheDocument();
  });

  it("shows the auto-run line when an automation prop is given", async () => {
    stubStatus({ active: false, startedAt: null });

    render(
      <MistralDispatchWidget
        automation={{
          message: "started",
          lastRunAt: "2024-06-01T00:15:00.000Z",
          nextRunAt: "2024-06-02T00:15:00.000Z",
          isError: false,
        }}
      />,
    );

    expect(
      await screen.findByText(
        "Auto-run: started (Jun 1, 2024, 12:15 AM) · Next: Jun 2, 2024, 12:15 AM",
      ),
    ).toBeInTheDocument();
  });

  it("shows no Disable button when no cycle is running", async () => {
    stubStatus({ active: false, startedAt: null });

    render(<MistralDispatchWidget />);

    await screen.findByText("Not currently dispatching.");
    expect(screen.queryByRole("button", { name: /Disable/ })).not.toBeInTheDocument();
  });

  it("disables the Mistral dispatch cycle and hides the pill once stopped", async () => {
    const user = userEvent.setup();
    let status: MistralDispatchStatus = { active: true, startedAt: "2024-06-01T00:15:00.000Z" };
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      if (String(url).includes("/dispatch/mistral")) {
        if (init?.method === "DELETE") {
          status = { active: false, startedAt: null };
          return Promise.resolve({ ok: true, json: async () => status });
        }
        return Promise.resolve({ ok: true, json: async () => status });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MistralDispatchWidget />);

    const disableButton = await screen.findByRole("button", { name: "Disable" });
    await user.click(disableButton);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/dispatch/mistral"),
      expect.objectContaining({ method: "DELETE" }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Auto-dispatch active")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Disable/ })).not.toBeInTheDocument();
    });
  });

  it("shows an error and re-enables the button when disabling fails", async () => {
    const user = userEvent.setup();
    const activeStatus: MistralDispatchStatus = {
      active: true,
      startedAt: "2024-06-01T00:15:00.000Z",
    };
    const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/dispatch/mistral") && init?.method === "DELETE") {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ message: "boom" }) });
      }
      if (href.includes("/dispatch/mistral")) {
        return Promise.resolve({ ok: true, json: async () => activeStatus });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<MistralDispatchWidget />);

    const disableButton = await screen.findByRole("button", { name: "Disable" });
    await user.click(disableButton);

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable" })).toBeInTheDocument();
  });
});
