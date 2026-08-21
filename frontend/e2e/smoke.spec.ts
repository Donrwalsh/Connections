import { test, expect } from "@playwright/test";
import { mockLeaderboard, mockPuzzle } from "./fixtures";

test("the app boots and the shared header renders", async ({ page }) => {
  await mockLeaderboard(page);
  await mockPuzzle(page);
  await page.goto("/leaderboard");

  await expect(page.getByRole("link", { name: "Connections Lab" })).toBeVisible();
  await expect(page.getByText("Alphabetical").first()).toBeVisible();
});
