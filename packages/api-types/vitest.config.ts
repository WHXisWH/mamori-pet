import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijime/api-types',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
