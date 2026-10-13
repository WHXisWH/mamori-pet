import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@ijime/crisis-detector',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // 危機検知・暗号化・権限チェックのカバレッジは下げない。下限は 2026-10-12 の実測値を切り捨てた値で、カバレッジが上がったら合わせて引き上げる
    coverage: { thresholds: { statements: 97, branches: 88, functions: 100, lines: 97 } },
  },
});
