import { test, expect } from "@playwright/test";
import { mockLeaderboard } from "./fixtures";

test("calendar popover stays within the viewport at a narrow phone width", async ({ page }) => {
  await mockLeaderboard(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/leaderboard");

  await page.getByRole("button", { name: "Calendar" }).click();
  const popover = page.getByRole("dialog", { name: "Calendar" });
  await expect(popover).toBeVisible();

  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);

  // Sits below the sticky header, not overlapping it.
  expect(box!.y).toBeGreaterThanOrEqual(60);
});
