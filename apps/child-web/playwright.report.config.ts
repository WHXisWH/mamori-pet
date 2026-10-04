import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from './playwright.config';

const root = resolve(process.env['E2E_REPORT_ROOT'] ?? '../../artifacts/e2e-2026-10-02');

export default defineConfig(base, {
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: resolve(root, 'raw-results'),
  reporter: [
    ['list'],
    ['json', { outputFile: resolve(root, 'results.json') }],
    ['html', { outputFolder: resolve(root, 'playwright'), open: 'never' }],
  ],
  use: {
    trace: 'on',
    screenshot: 'on',
    colorScheme: 'light',
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      name: 'desktop',
      use: {
        viewport: { width: 1440, height: 1000 },
        isMobile: false,
        hasTouch: false,
        userAgent: 'Mozilla/5.0 E2E-Desktop',
      },
    },
  ],
});
