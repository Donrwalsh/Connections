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
    // At mobile width, tiles should use the mobile panel-open font-size
    // rule (0.95rem = 15.2px at the site's 16px mobile root font-size), not
    // the desktop 0.8x-scale value (0.7rem = 11.2px). Tile.tsx also runs its
    // own fit-to-cell shrink on top of that CSS base once the tile's actual
    // (font-independent, so platform-stable) box geometry is known — at this
    // viewport the tile is narrow enough that the fitted size lands below
    // the 15.2px CSS base, at 15.2 * (clientWidth - 2*H_PAD) / clientWidth
    // ≈ 10.58px. Match with a regex rather than an exact string so the
    // assertion isn't pinned to every trailing digit of that float.
    await expect(page.locator(".tile").first()).toHaveCSS("font-size", /^10\.58\d*px$/);

    // Confirm the board is still actually usable after the panel opens —
    // a geometry-only check can pass even if tiles are visually clipped or
    // their hit-testing is offset from their visible position (the pre-fix
    // layout combined overflow: hidden, max-height + overflow-y: auto, and
    // a transform: scale(0.8), any of which could produce that mismatch).
    const firstTile = page.locator(".tile").first();
    await firstTile.click();
    await expect(firstTile).toHaveClass(/tile--selected/);
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
