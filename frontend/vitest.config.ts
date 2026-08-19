import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
      css: true,
      // formatTimestamp (metrics.ts) deliberately renders in the *browser's*
      // local timezone — pinning the test runner's own timezone to UTC keeps
      // assertions on its output deterministic across machines/CI, without
      // affecting real users (a real browser's Intl always reflects its own
      // system timezone regardless of this).
      env: { TZ: "UTC" },
      coverage: {
        provider: "v8",
        reporter: ["text", "json", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: [
          "src/test/**",
          "src/**/__tests__/**",
          "src/main.tsx",
          "src/vite-env.d.ts",
        ],
        thresholds: {
          global: {
            statements: 75,
            branches: 75,
            functions: 75,
            lines: 75,
          },
        },
      },
    },
  }),
);
