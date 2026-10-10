import { describe, expect, it } from 'vitest';

import { inShard, jobShard, shardOf } from './ids.js';

describe('shardOf', () => {
  it('assigns every key to exactly one shard, stably', () => {
    const keys = Array.from({ length: 500 }, (_, i) => `c_${i}`);
    const counts = [0, 0, 0, 0];
    for (const k of keys) {
      const s = shardOf(k, 4);
      expect(shardOf(k, 4)).toBe(s);
      expect([0, 1, 2, 3].filter((i) => inShard(k, { index: i, count: 4 }))).toEqual([s]);
      counts[s]!++;
    }
    // ハッシュによるシャード分割はおおむね均等：子ども500人を4シャードに分けると、各シャード90人以上
    for (const c of counts) expect(c).toBeGreaterThan(90);
  });

  it('a single shard owns everything', () => {
    expect(inShard('anything', { index: 0, count: 1 })).toBe(true);
    expect(() => shardOf('k', 0)).toThrow();
  });
});

describe('jobShard', () => {
  it('reads the Cloud Run task env and defaults to one task', () => {
    expect(jobShard({})).toEqual({ index: 0, count: 1 });
    expect(jobShard({ CLOUD_RUN_TASK_INDEX: '2', CLOUD_RUN_TASK_COUNT: '3' })).toEqual({
      index: 2,
      count: 3,
    });
  });

  it('rejects an index outside the task count', () => {
    expect(() => jobShard({ CLOUD_RUN_TASK_INDEX: '3', CLOUD_RUN_TASK_COUNT: '3' })).toThrow();
    expect(() => jobShard({ CLOUD_RUN_TASK_INDEX: '-1', CLOUD_RUN_TASK_COUNT: '3' })).toThrow();
    expect(() => jobShard({ CLOUD_RUN_TASK_COUNT: 'x' })).toThrow();
  });
});
