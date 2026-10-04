import { defineConfig, devices } from '@playwright/test';
import { localEnvironment, localPorts } from '../../scripts/local-ports.mjs';

const chromiumPath = process.env['PW_CHROMIUM_PATH'];

const ports = localPorts();
const localEnv = localEnvironment();
const PORT = ports.child;
process.env['NEXT_PUBLIC_API_BASE_URL'] ??= localEnv.NEXT_PUBLIC_API_BASE_URL;
process.env['NEXT_PUBLIC_VOICE_WS_URL'] ??= localEnv.NEXT_PUBLIC_VOICE_WS_URL;
process.env['NEXT_DIST_DIR'] ??= localEnv.NEXT_DIST_DIR;
process.env['PW_GUARDIAN_URL'] ??= `http://localhost:${ports.guardian}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Pixel 7'],
    locale: 'ja-JP',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      ...(chromiumPath ? { executablePath: chromiumPath } : {}),
    },
  },
  webServer: {
    command: 'node scripts/dev-local.mjs',
    cwd: '../..',
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
