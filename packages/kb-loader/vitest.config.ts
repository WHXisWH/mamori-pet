import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@ijime/kb-loader',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
