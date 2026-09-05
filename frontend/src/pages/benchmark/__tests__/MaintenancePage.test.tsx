import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAuthContext } from "../../../auth/useAdminAuth";
import { MaintenancePage } from "../MaintenancePage";

function renderPage(isAdmin: boolean) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <AdminAuthContext.Provider
      value={{ isAdmin, isLoading: false, login: vi.fn(), logout: vi.fn() }}
    >
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/maintenance"]}>
          <MaintenancePage />
        </MemoryRouter>
      </QueryClientProvider>
    </AdminAuthContext.Provider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MaintenancePage", () => {
  it("renders the panel for an admin session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ erroredRuns: 0, failed: 0 }) })),
    );
    renderPage(true);

    expect(await screen.findByRole("heading", { name: "Maintenance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bulk cleanup" })).toBeInTheDocument();
  });

  it("shows a not-found message for a non-admin visitor", () => {
    renderPage(false);

    expect(screen.getByText("Not found.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Maintenance" })).not.toBeInTheDocument();
  });
});
