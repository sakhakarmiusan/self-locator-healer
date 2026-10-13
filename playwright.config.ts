import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Single worker: the healing modules share JSON files in data/.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  // No `webServer` block on purpose: start the site yourself with
  // `npm run site` (or `node site-server.js`) before running the tests.
});
