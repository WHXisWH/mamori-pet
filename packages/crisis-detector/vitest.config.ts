import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijime/crisis-detector',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
