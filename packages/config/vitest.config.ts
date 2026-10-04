import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijime/config',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
