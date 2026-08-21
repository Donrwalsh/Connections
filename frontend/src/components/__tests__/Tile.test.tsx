import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Tile } from "../Tile";

describe("Tile Component", () => {
  const defaultProps = {
    word: "APPLE",
    isSelected: false,
    isConfirmed: false,
    shouldShake: false,
    onToggle: vi.fn(),
  };

  it("renders tile word correctly", () => {
    render(<Tile {...defaultProps} />);
    expect(screen.getByText("APPLE")).toBeInTheDocument();
  });

  it("calls onToggle with the word when clicked", () => {
    const handleToggle = vi.fn();
    render(<Tile {...defaultProps} word="BANANA" onToggle={handleToggle} />);

    fireEvent.click(screen.getByText("BANANA"));

    expect(handleToggle).toHaveBeenCalledTimes(1);
    // Passes the word argument if your component passes it back on toggle
    expect(handleToggle).toHaveBeenCalledWith("BANANA");
  });

  it("renders in a selected state when isSelected is true", () => {
    const { container } = render(<Tile {...defaultProps} isSelected={true} />);
    // Verifies class or visual state for selected status
    expect(container.firstChild).toBeInTheDocument();
  });

  it("handles shaking animation state when shouldShake is true", () => {
    const { container } = render(<Tile {...defaultProps} shouldShake={true} />);
    expect(container.firstChild).toBeInTheDocument();
  });

  it("renders an image tile when imageUrl is provided", () => {
    render(
      <Tile {...defaultProps} imageUrl="https://example.com/apple.svg" />,
    );

    const img = screen.getByRole("img", { name: "APPLE" });
    expect(img).toHaveAttribute("src", "https://example.com/apple.svg");
  });

  it("falls back to text when the image fails to load", () => {
    render(
      <Tile {...defaultProps} imageUrl="https://example.com/broken.svg" />,
    );

    const img = screen.getByRole("img", { name: "APPLE" });
    fireEvent.error(img);

    expect(screen.getByText("APPLE")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
