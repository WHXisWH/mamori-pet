import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@ijime/landing-web',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
});
