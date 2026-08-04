import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatePicker } from "../DatePicker";

const MIN_DATE = "2023-06-12";

const todayString = () => new Date().toISOString().split("T")[0];

let mockedParams: { date?: string } = {};
const navigateMock = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<
    typeof import("react-router-dom")
  >("react-router-dom");
  return {
    ...actual,
    useParams: () => mockedParams,
    useNavigate: () => navigateMock,
  };
});

describe("DatePicker navigation arrows", () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  it("hides the previous arrow on the earliest day", () => {
    mockedParams = { date: MIN_DATE };

    render(<DatePicker />);

    expect(
      screen.queryByRole("button", { name: "Previous puzzle" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Next puzzle" }),
    ).toBeInTheDocument();
  });

  it("hides the next arrow when viewing today", () => {
    mockedParams = { date: todayString() };

    render(<DatePicker />);

    expect(
      screen.getByRole("button", { name: "Previous puzzle" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next puzzle" }),
    ).not.toBeInTheDocument();
  });

  it("shows both arrows for a date in the middle of the range", () => {
    mockedParams = { date: "2024-01-15" };

    render(<DatePicker />);

    expect(
      screen.getByRole("button", { name: "Previous puzzle" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Next puzzle" }),
    ).toBeInTheDocument();
  });

  it("navigates to the previous day when the previous arrow is clicked", async () => {
    const user = userEvent.setup();
    mockedParams = { date: "2024-01-15" };

    render(<DatePicker />);

    await user.click(
      screen.getByRole("button", { name: "Previous puzzle" }),
    );
    expect(navigateMock).toHaveBeenCalledWith("/puzzle/2024-01-14");
  });

  it("navigates to the next day when the next arrow is clicked", async () => {
    const user = userEvent.setup();
    mockedParams = { date: "2024-01-15" };

    render(<DatePicker />);

    await user.click(screen.getByRole("button", { name: "Next puzzle" }));
    expect(navigateMock).toHaveBeenCalledWith("/puzzle/2024-01-16");
  });

  it("shows only the previous arrow on the index route (today's puzzle)", () => {
    mockedParams = {};

    render(<DatePicker />);

    expect(
      screen.getByRole("button", { name: "Previous puzzle" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Next puzzle" }),
    ).not.toBeInTheDocument();
  });

  it("navigates to a date within the range when the random button is clicked", async () => {
    const user = userEvent.setup();
    mockedParams = { date: "2024-01-15" };

    render(<DatePicker />);

    await user.click(
      screen.getByRole("button", { name: "Random puzzle" }),
    );

    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0][0] as string;
    expect(target).toMatch(/^\/puzzle\/\d{4}-\d{2}-\d{2}$/);

    const dateStr = target.replace("/puzzle/", "");
    expect(dateStr >= MIN_DATE && dateStr <= todayString()).toBe(true);
  });
});
