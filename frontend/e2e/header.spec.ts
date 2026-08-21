import { test, expect } from "@playwright/test";
import { mockLeaderboard, mockPuzzle } from "./fixtures";

test.describe("header nav responsiveness", () => {
  test("collapses nav labels to icon-only at mobile width", async ({ page }) => {
    await mockLeaderboard(page);
    await mockPuzzle(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/leaderboard");

    const todayLink = page.getByRole("link", { name: "Today's puzzle" });
    await expect(todayLink).toBeVisible();
    await expect(todayLink.locator(".site-header__link-label")).toBeHidden();

    await todayLink.click();
    await expect(page).toHaveURL("/");
  });

  test("keeps nav labels visible at desktop width", async ({ page }) => {
    await mockLeaderboard(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/leaderboard");

    const todayLink = page.getByRole("link", { name: "Today's puzzle" });
    await expect(todayLink.locator(".site-header__link-label")).toBeVisible();
  });
});
