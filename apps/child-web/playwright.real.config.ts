import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { localPorts } from '../../scripts/local-ports.mjs';

const ports = localPorts();
if (process.env['REAL_BUSINESS_APPROVED'] !== '1')
  throw new Error('Real model browser tests require explicit opt-in');
const output = resolve('../../artifacts/real-agent-2026-10-02/real-browser');

export default defineConfig({
  testDir: './e2e-real',
  workers: 1,
  retries: 0,
  timeout: 75_000,
  expect: { timeout: 40_000 },
  outputDir: resolve(output, 'raw-results'),
  reporter: [
    ['list'],
    ['json', { outputFile: resolve(output, 'results.json') }],
    ['html', { outputFolder: resolve(output, 'playwright'), open: 'never' }],
  ],
  use: {
    baseURL: `http://localhost:${ports.child}`,
    locale: 'ja-JP',
    screenshot: 'on',
    trace: 'on',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: 'node scripts/dev-local.mjs --real',
    cwd: '../..',
    port: ports.child,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
