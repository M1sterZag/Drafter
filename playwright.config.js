// playwright.config.js — браузерные e2e: мок OpenDota + backend + Vite dev-сервер
// E2E_REAL_HEROES=1 — брать героев из настоящего OpenDota API вместо мока.
// E2E_BASE_URL=https://host:port — гонять тесты против уже запущенного стека (например, docker compose).
const { defineConfig } = require('@playwright/test');

const MOCK_PORT = 4599;
const BACKEND_PORT = 3199;
const FRONT_PORT = 5199;
const heroesUrl = process.env.E2E_REAL_HEROES
  ? 'https://api.opendota.com/api/heroes'
  : `http://127.0.0.1:${MOCK_PORT}/api/heroes`;

const externalUrl = process.env.E2E_BASE_URL;

module.exports = defineConfig({
  testDir: './e2e/browser',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e/report' }]],
  outputDir: 'e2e/test-results',
  use: {
    baseURL: externalUrl || `http://127.0.0.1:${FRONT_PORT}`,
    ignoreHTTPSErrors: true, // Caddy с `tls internal` выдаёт самоподписанный сертификат
    // Системный Google Chrome — не нужно скачивать браузеры Playwright
    channel: process.env.E2E_BROWSER_CHANNEL || 'chrome',
    headless: !process.env.HEADED,
    viewport: { width: 1600, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  webServer: externalUrl ? undefined : [
    {
      command: 'node e2e/mock-heroes-server.js',
      url: `http://127.0.0.1:${MOCK_PORT}/health`,
      env: { MOCK_PORT: String(MOCK_PORT) },
      reuseExistingServer: false,
    },
    {
      command: 'node server/index.js',
      port: BACKEND_PORT,
      env: { PORT: String(BACKEND_PORT), HEROES_URL: heroesUrl, DRAFT_MAIN_TIME: '600' },
      reuseExistingServer: false,
    },
    {
      command: `npm --prefix client run dev -- --port ${FRONT_PORT}`,
      url: `http://127.0.0.1:${FRONT_PORT}`,
      env: { BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}` },
      reuseExistingServer: false,
    },
  ],
});
