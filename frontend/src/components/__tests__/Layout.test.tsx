import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Layout } from "../Layout";

vi.mock("react-router-dom", () => ({
  Outlet: () => <div>outlet-content</div>,
}));

vi.mock("../DatePicker", () => ({
  DatePicker: () => <div>date-picker-mock</div>,
}));

describe("Layout Component", () => {
  it("renders the header with the date picker", () => {
    render(<Layout />);

    expect(screen.getByText("date-picker-mock")).toBeInTheDocument();
  });

  it("renders the outlet content", () => {
    render(<Layout />);

    expect(screen.getByText("outlet-content")).toBeInTheDocument();
  });
});
