import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
  },
  webServer: {
    // Rebuilds on every run so `npm run test:e2e` is self-contained locally
    // and in CI, regardless of whether a prior build step already ran.
    command: "npm run build && npm run preview -- --port 4173",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    env: {
      // Empty (not unset) so import.meta.env.VITE_API_URL resolves API
      // calls to clean same-origin absolute paths like "/game/puzzle/today"
      // instead of the literal string "undefined/game/puzzle/today".
      VITE_API_URL: "",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
