import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'infra-policy',
          include: ['src/policy/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'infra-rules',
          include: ['src/rules/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
