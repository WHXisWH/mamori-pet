import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'services/*', 'infra/tests', 'apps/child-web', 'apps/landing-web'],
  },
});
