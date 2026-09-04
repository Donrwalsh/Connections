import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MaintenancePanel } from "../MaintenancePanel";

interface Counts {
  erroredRuns: number;
  failed: number;
}

/** Stubs fetch for both count GETs and both bulk DELETEs. `counts` is read
 * live on every call so a delete handler can mutate it and the refetch sees
 * the new figure. */
function stubFetch(counts: Counts) {
  const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";

    if (href.includes("/dispatch/runs/errored")) {
      if (method === "DELETE") {
        counts.erroredRuns = 0;
        return Promise.resolve({
          ok: true,
          json: async () => ({ message: "Deleted 3 errored strategy run(s) and all related data" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ erroredRuns: counts.erroredRuns }) });
    }

    if (href.includes("/category-evaluation/failed")) {
      if (method === "DELETE") {
        counts.failed = 0;
        return Promise.resolve({
          ok: true,
          json: async () => ({ message: "Deleted 7 failed judge call(s); the next dispatch will re-judge them" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ failed: counts.failed }) });
    }

    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MaintenancePanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MaintenancePanel", () => {
  it("shows the errored-run and failed-judge-call counts", async () => {
    stubFetch({ erroredRuns: 3, failed: 7 });
    renderPanel();

    const erroredRow = (await screen.findByText(/errored strategy runs/i)).closest("li")!;
    expect(await within(erroredRow).findByText("3")).toBeInTheDocument();

    const failedRow = screen.getByText("Failed judge calls").closest("li")!;
    expect(await within(failedRow).findByText("7")).toBeInTheDocument();
  });

  it("disables a delete button when its count is zero", async () => {
    stubFetch({ erroredRuns: 0, failed: 7 });
    renderPanel();

    // Wait for both queries to settle (the failed count renders once loaded).
    await screen.findByText("7");

    expect(screen.getByRole("button", { name: /delete errored runs/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /delete failed judge calls/i })).toBeEnabled();
  });

  it("opens the errored-runs confirm modal from its button", async () => {
    const user = userEvent.setup();
    stubFetch({ erroredRuns: 3, failed: 7 });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /delete errored runs/i }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /delete errored runs/i })).toBeInTheDocument();
  });

  it("refetches the counts after a bulk delete completes", async () => {
    const user = userEvent.setup();
    stubFetch({ erroredRuns: 3, failed: 7 });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: /delete errored runs/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Delete errored runs" }),
    );

    // Result message from the bulk call, then the panel's re-read shows 0.
    expect(await screen.findByText(/Deleted 3 errored strategy run/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));

    const erroredRow = (await screen.findByText(/errored strategy runs/i)).closest("li")!;
    await vi.waitFor(() => expect(within(erroredRow).getByText("0")).toBeInTheDocument());
  });
});
