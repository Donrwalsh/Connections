import { test, expect } from "@playwright/test";
import { mockLeaderboard } from "./fixtures";

test.describe("leaderboard table responsiveness", () => {
  test("fits within the viewport at mobile width without horizontal scroll", async ({ page }) => {
    await mockLeaderboard(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/leaderboard");

    const wrap = page.locator(".bench-table-wrap").first();
    await expect(wrap).toBeVisible();

    // StrategyTable is a fluid CSS-grid table: its columns shrink (and some
    // hide below 900px) to fit narrow viewports instead of relying on
    // horizontal scroll, unlike the fixed-width tables .bench-table-wrap
    // also wraps elsewhere.
    const scrollWidth = await wrap.evaluate((el) => el.scrollWidth);
    const clientWidth = await wrap.evaluate((el) => el.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

    // The wrapper itself never exceeds the viewport either.
    const wrapBox = await wrap.boundingBox();
    expect(wrapBox).not.toBeNull();
    expect(wrapBox!.width).toBeLessThanOrEqual(375);
  });

  test("a row still navigates to the strategy detail page at mobile width", async ({ page }) => {
    await mockLeaderboard(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/leaderboard");

    await page.getByRole("link", { name: "View Alphabetical details" }).click();
    await expect(page).toHaveURL("/leaderboard/alphabetical");
  });
});
