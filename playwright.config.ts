import { defineConfig, devices } from "@playwright/test";
import dotenv from "dotenv";

// Load local env (Supabase keys, E2E credentials). In CI these values come
// from GitHub Actions secrets and .env.local is absent — dotenv is a no-op.
dotenv.config({ path: ".env.local" });

/**
 * Playwright E2E configuration.
 * Until the Vercel preview is connected, the suite runs against a local
 * production build (`npm run build && npm run start`).
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html"], ["list"]] : "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run build && npm run start",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
