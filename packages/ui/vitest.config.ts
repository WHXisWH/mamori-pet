import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijime/ui',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    environment: 'jsdom',
  },
});
