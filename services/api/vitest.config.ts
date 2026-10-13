import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@ijime/api',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // 認証と権限チェック（カバレッジは下げない）：下限は 2026-10-12 の実測値を切り捨てた値で、カバレッジが上がったら合わせて引き上げる
    coverage: {
      include: ['src/auth.ts'],
      thresholds: { statements: 91, branches: 87, functions: 100, lines: 92 },
    },
  },
});
