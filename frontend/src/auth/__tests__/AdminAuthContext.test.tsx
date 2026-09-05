import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_SESSION_EXPIRED_EVENT } from "../../data/benchmark/api";
import { AdminAuthProvider, useAdminAuth } from "../AdminAuthContext";

function Probe() {
  const { isAdmin, isLoading, login, logout } = useAdminAuth();
  return (
    <div>
      <span>isAdmin: {String(isAdmin)}</span>
      <span>isLoading: {String(isLoading)}</span>
      <button onClick={() => login("hunter2").catch(() => {})}>login</button>
      <button onClick={() => logout()}>logout</button>
    </div>
  );
}

/** Stateful stub: a real backend flips what /auth/me reports after a
 * successful login/logout (the session cookie changes), so this tracks that
 * instead of always answering with the initial `meIsAdmin` value. */
function stubFetch(meIsAdmin: boolean, loginOk = true) {
  let loggedIn = meIsAdmin;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: unknown) => {
      const href = String(url);
      if (href.includes("/auth/login")) {
        if (loginOk) loggedIn = true;
        return Promise.resolve({
          ok: loginOk,
          status: loginOk ? 200 : 403,
          json: async () => (loginOk ? { ok: true } : { message: "Incorrect password." }),
        });
      }
      if (href.includes("/auth/logout")) {
        loggedIn = false;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ isAdmin: loggedIn }) });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AdminAuthProvider", () => {
  it("starts loading, then reflects /auth/me", async () => {
    stubFetch(true);
    render(
      <AdminAuthProvider>
        <Probe />
      </AdminAuthProvider>,
    );

    expect(screen.getByText("isLoading: true")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("isLoading: false")).toBeInTheDocument());
    expect(screen.getByText("isAdmin: true")).toBeInTheDocument();
  });

  it("flips isAdmin true after a successful login", async () => {
    const user = userEvent.setup();
    stubFetch(false);
    render(
      <AdminAuthProvider>
        <Probe />
      </AdminAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("isLoading: false")).toBeInTheDocument());

    await user.click(screen.getByText("login"));
    await waitFor(() => expect(screen.getByText("isAdmin: true")).toBeInTheDocument());
  });

  it("flips isAdmin false on logout", async () => {
    const user = userEvent.setup();
    stubFetch(true);
    render(
      <AdminAuthProvider>
        <Probe />
      </AdminAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("isAdmin: true")).toBeInTheDocument());

    await user.click(screen.getByText("logout"));
    await waitFor(() => expect(screen.getByText("isAdmin: false")).toBeInTheDocument());
  });

  it("flips isAdmin false when ADMIN_SESSION_EXPIRED_EVENT fires", async () => {
    stubFetch(true);
    render(
      <AdminAuthProvider>
        <Probe />
      </AdminAuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("isAdmin: true")).toBeInTheDocument());

    act(() => {
      window.dispatchEvent(new Event(ADMIN_SESSION_EXPIRED_EVENT));
    });

    expect(screen.getByText("isAdmin: false")).toBeInTheDocument();
  });
});

describe("useAdminAuth without a provider", () => {
  it("defaults to a logged-out, non-loading state", () => {
    render(<Probe />);
    expect(screen.getByText("isAdmin: false")).toBeInTheDocument();
    expect(screen.getByText("isLoading: false")).toBeInTheDocument();
  });
});
