import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'agent-core-unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.firestore.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'agent-core-firestore',
          include: ['src/**/*.firestore.test.ts'],
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
