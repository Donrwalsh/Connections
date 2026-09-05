import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminAuthContext } from "../../auth/useAdminAuth";
import { Header } from "../Header";
import { monthLabel, todayUtcString } from "../../data/calendarMock";

function renderHeader(initialEntry = "/leaderboard") {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Header />
    </MemoryRouter>,
  );
}

function renderHeaderAsAdmin(initialEntry = "/leaderboard") {
  return render(
    <AdminAuthContext.Provider
      value={{ isAdmin: true, isLoading: false, login: vi.fn(), logout: vi.fn() }}
    >
      <MemoryRouter initialEntries={[initialEntry]}>
        <Header />
      </MemoryRouter>
    </AdminAuthContext.Provider>,
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

function LocationDisplay() {
  const location = useLocation();
  return <div>{location.pathname}</div>;
}

describe("Header", () => {
  it("shows the wordmark and all nav items", () => {
    renderHeader();

    expect(screen.getByRole("link", { name: "Connections Lab" })).toHaveAttribute(
      "href",
      "/leaderboard",
    );
    expect(screen.getByRole("link", { name: "Today's puzzle" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Leaderboard" })).toHaveAttribute(
      "href",
      "/leaderboard",
    );
    expect(screen.getByRole("button", { name: "Calendar" })).toBeInTheDocument();
  });

  it("gives icon-only nav links an explicit aria-label", () => {
    renderHeader();

    expect(screen.getByRole("link", { name: "Today's puzzle" })).toHaveAttribute(
      "aria-label",
      "Today's puzzle",
    );
    expect(screen.getByRole("link", { name: "Leaderboard" })).toHaveAttribute(
      "aria-label",
      "Leaderboard",
    );
    expect(screen.getByRole("link", { name: "Activity" })).toHaveAttribute("aria-label", "Activity");
  });

  it("marks Today's puzzle active only on exactly /", () => {
    renderHeader("/");

    const todayLink = screen.getByRole("link", { name: "Today's puzzle" });
    const leaderboardLink = screen.getByRole("link", { name: "Leaderboard" });

    expect(todayLink.className).toContain("site-header__link--active");
    expect(leaderboardLink.className).not.toContain("site-header__link--active");
  });

  it("marks Leaderboard active anywhere under /leaderboard", () => {
    renderHeader("/leaderboard/alphabetical");

    const todayLink = screen.getByRole("link", { name: "Today's puzzle" });
    const leaderboardLink = screen.getByRole("link", { name: "Leaderboard" });

    expect(leaderboardLink.className).toContain("site-header__link--active");
    expect(todayLink.className).not.toContain("site-header__link--active");
  });

  it("opens and closes the calendar popover from the icon button", async () => {
    const user = userEvent.setup();
    renderHeader();

    const button = screen.getByRole("button", { name: "Calendar" });
    expect(screen.queryByRole("dialog", { name: "Calendar" })).not.toBeInTheDocument();

    await user.click(button);
    const today = todayUtcString();
    const month = Number(today.slice(5, 7)) - 1;
    const year = Number(today.slice(0, 4));
    expect(screen.getByRole("dialog", { name: "Calendar" })).toBeInTheDocument();
    expect(screen.getByText(monthLabel(year, month))).toBeInTheDocument();

    await user.click(button);
    expect(screen.queryByRole("dialog", { name: "Calendar" })).not.toBeInTheDocument();
  });

  it("closes the popover on Escape", async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole("button", { name: "Calendar" }));
    expect(screen.getByRole("dialog", { name: "Calendar" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Calendar" })).not.toBeInTheDocument();
  });

  it("closes the popover when clicking outside it", async () => {
    const user = userEvent.setup();
    renderHeader();

    await user.click(screen.getByRole("button", { name: "Calendar" }));
    expect(screen.getByRole("dialog", { name: "Calendar" })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Calendar" })).not.toBeInTheDocument();
  });

  it("opens the calendar pre-selected on today when on the root route", async () => {
    const user = userEvent.setup();
    renderHeader("/");

    await user.click(screen.getByRole("button", { name: "Calendar" }));

    const today = todayUtcString();
    expect(screen.getByRole("button", { name: today }).className).toContain(
      "calendar-popover__cell--selected",
    );
  });

  it("opens the calendar pre-selected on the current puzzle's date", async () => {
    const user = userEvent.setup();
    renderHeader("/puzzle/2023-06-12");

    await user.click(screen.getByRole("button", { name: "Calendar" }));

    expect(screen.getByRole("button", { name: "2023-06-12" }).className).toContain(
      "calendar-popover__cell--selected",
    );
  });

  it("opens the calendar with nothing selected outside puzzle pages", async () => {
    const user = userEvent.setup();
    renderHeader("/leaderboard");

    await user.click(screen.getByRole("button", { name: "Calendar" }));

    const today = todayUtcString();
    expect(screen.getByRole("button", { name: today }).className).not.toContain(
      "calendar-popover__cell--selected",
    );
  });

  it("hides the Maintenance link and Log out button for a non-admin visitor", () => {
    renderHeader();

    expect(screen.queryByRole("link", { name: "Maintenance" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });

  it("shows the Maintenance link and Log out button for an admin session", () => {
    renderHeaderAsAdmin();

    expect(screen.getByRole("link", { name: "Maintenance" })).toHaveAttribute(
      "href",
      "/maintenance",
    );
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("calls logout when the Log out button is clicked", async () => {
    const user = userEvent.setup();
    const logout = vi.fn();
    render(
      <AdminAuthContext.Provider value={{ isAdmin: true, isLoading: false, login: vi.fn(), logout }}>
        <MemoryRouter initialEntries={["/leaderboard"]}>
          <Header />
        </MemoryRouter>
      </AdminAuthContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(logout).toHaveBeenCalled();
  });

  it("navigates to a random puzzle from the shuffle icon", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/leaderboard"]}>
        <Header />
        <Routes>
          <Route path="/puzzle/:date" element={<LocationDisplay />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Random puzzle" }));

    expect(await screen.findByText(/^\/puzzle\/\d{4}-\d{2}-\d{2}$/)).toBeInTheDocument();
  });
});
