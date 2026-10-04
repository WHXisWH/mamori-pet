import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijime/service-kit',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
