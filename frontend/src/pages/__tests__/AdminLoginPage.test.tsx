import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAuthProvider } from "../../auth/AdminAuthContext";
import { AdminLoginPage } from "../AdminLoginPage";

function stubFetch(login: { ok: boolean; status?: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const href = String(url);
      if (href.includes("/auth/login")) {
        return Promise.resolve({
          ok: login.ok,
          status: login.status ?? 200,
          json: async () => login.body,
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ isAdmin: false }) });
    }),
  );
}

function renderPage() {
  render(
    <AdminAuthProvider>
      <MemoryRouter initialEntries={["/admin-login"]}>
        <Routes>
          <Route path="/admin-login" element={<AdminLoginPage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>
    </AdminAuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminLoginPage", () => {
  it("logs in and navigates home on the correct password", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: true, body: { ok: true } });
    renderPage();

    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("home")).toBeInTheDocument();
  });

  it("shows the backend's error message on a wrong password", async () => {
    const user = userEvent.setup();
    stubFetch({ ok: false, status: 403, body: { message: "Incorrect password." } });
    renderPage();

    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Incorrect password.")).toBeInTheDocument();
  });
});
