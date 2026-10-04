import { describe, expect, it } from 'vitest';

import * as enums from './enums.js';
import { ERROR_CODES } from './errors.js';
import { PUBSUB_TOPICS } from './internal.js';

describe('enums', () => {
  it('all enum values are lowercase snake_case', () => {
    const lists = Object.entries(enums).filter(([, v]) => Array.isArray(v)) as [
      string,
      readonly string[],
    ][];
    expect(lists.length).toBeGreaterThan(10);
    for (const [, values] of lists) {
      for (const v of values) expect(v).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('has 7 MVP signal domains and 5 risk levels', () => {
    expect(enums.DOMAINS).toEqual(['a', 'v', 'k', 'd', 'm', 'i', 'x']);
    expect(enums.RISK_LEVELS).toHaveLength(5);
  });

  it('error codes map to valid HTTP statuses', () => {
    for (const status of Object.values(ERROR_CODES)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('defines the 8 Pub/Sub topics from the API doc', () => {
    expect(PUBSUB_TOPICS).toHaveLength(8);
  });
});
