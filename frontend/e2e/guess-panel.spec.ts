import { test, expect } from "@playwright/test";
import { mockGuessSequenceRuns, mockPuzzle } from "./fixtures";

test.describe("guess-sequence panel responsiveness", () => {
  test("stacks below the board at mobile width when opened", async ({ page }) => {
    await mockPuzzle(page);
    await mockGuessSequenceRuns(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/puzzle/2024-01-15");

    await page.getByRole("button", { name: /Show Alphabetical/ }).click();
    // Wait for the panel's content to actually render before measuring
    // layout — the click only triggers a state update, and reading
    // boundingBox() immediately after could catch a stale pre-render frame.
    await expect(page.locator(".guess-sequence__content")).toBeVisible();

    const board = page.locator(".puzzle-page__board");
    const panel = page.locator(".puzzle-page__panel");
    const boardBox = await board.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(boardBox).not.toBeNull();
    expect(panelBox).not.toBeNull();

    // Stacked: the panel starts at/below the board's bottom edge.
    expect(panelBox!.y).toBeGreaterThanOrEqual(boardBox!.y + boardBox!.height - 1);
    // The board keeps a normal (unscaled) width instead of the desktop
    // side-by-side layout's fixed 500px-scaled-to-80% canvas.
    expect(boardBox!.width).toBeGreaterThan(300);
    // At mobile width, tiles should not be shrunk to 0.7rem anymore
    // (they were sized for the desktop 0.8x scale, but mobile has no scaling)
    await expect(page.locator(".tile").first()).not.toHaveCSS("font-size", "11.2px");
  });

  test("sits beside the board at desktop width when opened", async ({ page }) => {
    await mockPuzzle(page);
    await mockGuessSequenceRuns(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/puzzle/2024-01-15");

    await page.getByRole("button", { name: /Show Alphabetical/ }).click();
    await expect(page.locator(".guess-sequence__content")).toBeVisible();

    const board = page.locator(".puzzle-page__board");
    const panel = page.locator(".puzzle-page__panel");
    const boardBox = await board.boundingBox();
    const panelBox = await panel.boundingBox();
    expect(boardBox).not.toBeNull();
    expect(panelBox).not.toBeNull();

    // Side-by-side: the panel starts at/right of the board's right edge.
    expect(panelBox!.x).toBeGreaterThanOrEqual(boardBox!.x + boardBox!.width - 1);
  });
});
