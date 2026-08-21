import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarPopover } from "../CalendarPopover";
import {
  CALENDAR_MIN_DATE,
  getMonthGrid,
  isDateInRange,
  maxMonth,
  monthLabel,
  monthOfDate,
  todayUtcString,
} from "../../data/calendarMock";

const navigateMock = vi.fn();

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
}));

describe("CalendarPopover", () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it("opens on the latest month", () => {
    const { year, monthIndex } = maxMonth();

    render(<CalendarPopover onClose={vi.fn()} />);

    expect(screen.getByText(monthLabel(year, monthIndex))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to latest month" })).toBeDisabled();
  });

  it("shows day numbers for the visible month", () => {
    const today = todayUtcString();
    const day = String(Number(today.slice(8, 10)));

    render(<CalendarPopover onClose={vi.fn()} />);

    expect(screen.getByText(day)).toBeInTheDocument();
  });

  it("moves between months with the arrows", async () => {
    const user = userEvent.setup();
    const { year, monthIndex } = maxMonth();
    const previous = new Date(Date.UTC(year, monthIndex - 1, 1));

    render(<CalendarPopover onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Previous month" }));
    expect(
      screen.getByText(monthLabel(previous.getUTCFullYear(), previous.getUTCMonth())),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next month" })).toBeEnabled();
  });

  it("jumps to the oldest month and back with |< and >|", async () => {
    const user = userEvent.setup();
    render(<CalendarPopover onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Go to oldest month" }));
    expect(screen.getByText("June 2023")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to oldest month" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Go to latest month" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Go to latest month" }));
    const { year, monthIndex } = maxMonth();
    expect(screen.getByText(monthLabel(year, monthIndex))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to latest month" })).toBeDisabled();
  });

  it("renders out-of-range days as inert (oldest month)", async () => {
    const user = userEvent.setup();
    render(<CalendarPopover onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Go to oldest month" }));
    expect(screen.getByRole("button", { name: "2023-06-12" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2023-06-01" })).not.toBeInTheDocument();
  });

  it("renders buttons only for in-range dates", () => {
    const { year, monthIndex } = maxMonth();
    const expectedButtons = getMonthGrid(year, monthIndex).filter(
      (date) => date && isDateInRange(date),
    ).length;

    const { container } = render(<CalendarPopover onClose={vi.fn()} />);

    expect(container.querySelectorAll("button.calendar-popover__cell").length).toBe(
      expectedButtons,
    );
  });

  it("navigates to an in-range date and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const today = todayUtcString();

    render(<CalendarPopover onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: today }));
    expect(navigateMock).toHaveBeenCalledWith(`/puzzle/${today}`);
    expect(onClose).toHaveBeenCalled();
  });

  it("opens on the selected date's month and highlights it", () => {
    const { year, monthIndex } = monthOfDate(CALENDAR_MIN_DATE);

    render(<CalendarPopover onClose={vi.fn()} selectedDate={CALENDAR_MIN_DATE} />);

    expect(screen.getByText(monthLabel(year, monthIndex))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: CALENDAR_MIN_DATE }).className).toContain(
      "calendar-popover__cell--selected",
    );
  });

  it("falls back to the latest month when selectedDate is out of range", () => {
    const { year, monthIndex } = maxMonth();

    render(<CalendarPopover onClose={vi.fn()} selectedDate="2000-01-01" />);

    expect(screen.getByText(monthLabel(year, monthIndex))).toBeInTheDocument();
  });

  it("does not highlight any cell when selectedDate is omitted", () => {
    const today = todayUtcString();

    render(<CalendarPopover onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: today }).className).not.toContain(
      "calendar-popover__cell--selected",
    );
  });
});
