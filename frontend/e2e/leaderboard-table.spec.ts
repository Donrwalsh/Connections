import { test, expect } from "@playwright/test";
import { mockLeaderboard } from "./fixtures";

test.describe("leaderboard table responsiveness", () => {
  test("scrolls horizontally inside its wrapper at mobile width", async ({ page }) => {
    await mockLeaderboard(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/leaderboard");

    const wrap = page.locator(".bench-table-wrap").first();
    await expect(wrap).toBeVisible();

    const scrollWidth = await wrap.evaluate((el) => el.scrollWidth);
    const clientWidth = await wrap.evaluate((el) => el.clientWidth);
    expect(scrollWidth).toBeGreaterThan(clientWidth);

    // The wrapper itself never exceeds the viewport — it's the thing that
    // scrolls, not the page.
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
