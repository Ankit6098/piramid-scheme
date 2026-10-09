import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against a running stack — by default the production compose behind nginx
 * (`docker compose -f docker-compose.prod.yml --profile dev-mail up -d`, http://localhost:8080).
 * Email OTPs are read from Mailpit (MAILPIT_URL, default http://localhost:8025) via
 * tests/e2e/utils/mailpit.ts.
 *
 *   corepack pnpm exec playwright test                 # all projects
 *   corepack pnpm exec playwright test --project=chromium
 *   E2E_BASE_URL=http://localhost:3000 corepack pnpm exec playwright test   # against `pnpm dev`
 */
const isCI = !!process.env.CI;
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:8080';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: isCI
    ? [['list'], ['github'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list'], ['html', { open: 'on-failure', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
