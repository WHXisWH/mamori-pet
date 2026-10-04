import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@ijime/child-web',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    testTimeout: 30_000,
  },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
});
