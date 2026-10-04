import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijime/calendar-sync',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
