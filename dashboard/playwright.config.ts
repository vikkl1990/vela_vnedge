import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 8000 },
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:5179', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  // The API target is deliberately unreachable. Every API request is mocked; these tests cannot trade.
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5179 --strictPort',
    url: 'http://127.0.0.1:5179',
    env: { VNEDGE_API: 'http://127.0.0.1:1' },
    reuseExistingServer: false,
  },
})
