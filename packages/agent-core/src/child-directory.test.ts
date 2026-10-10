import { describe, expect, it } from 'vitest';

import {
  ScopedChildDirectory,
  withChildScope,
  type ChildDirectory,
  type ChildRecord,
} from './child-directory.js';

const record = (childId: string): ChildRecord => ({
  childId,
  familyId: 'f1',
  nickname: 'はな',
  gradeBand: 'high',
  characterId: 'moko',
  petId: 'p1',
  petName: '',
  dek: Buffer.alloc(32, 1),
});

function counting(result: (id: string) => Promise<ChildRecord | undefined>) {
  const calls: string[] = [];
  const inner: ChildDirectory = {
    lookup: (id) => {
      calls.push(id);
      return result(id);
    },
  };
  return { calls, dir: new ScopedChildDirectory(inner) };
}

describe('ScopedChildDirectory', () => {
  it('outside a request scope every lookup reaches the store', async () => {
    const { calls, dir } = counting(async (id) => record(id));
    await dir.lookup('c1');
    await dir.lookup('c1');
    expect(calls).toEqual(['c1', 'c1']);
  });

  it('inside one request scope the record is read once, also for concurrent callers', async () => {
    const { calls, dir } = counting(async (id) => record(id));
    await withChildScope(async () => {
      const [a, b] = await Promise.all([dir.lookup('c1'), dir.lookup('c1')]);
      await new Promise((r) => setTimeout(r, 1));
      const c = await dir.lookup('c1');
      expect(a).toBe(b);
      expect(c).toBe(a);
      await dir.lookup('c2');
    });
    expect(calls).toEqual(['c1', 'c2']);
  });

  it('separate requests never share a record (status changes apply on the next request)', async () => {
    const { calls, dir } = counting(async (id) => record(id));
    await withChildScope(() => dir.lookup('c1'));
    await withChildScope(() => dir.lookup('c1'));
    expect(calls).toEqual(['c1', 'c1']);
  });

  it('does not remember a missing child or a failed read', async () => {
    let n = 0;
    const { calls, dir } = counting(async (id) => {
      n++;
      if (n === 1) return undefined;
      if (n === 2) throw new Error('firestore unavailable');
      return record(id);
    });
    await withChildScope(async () => {
      expect(await dir.lookup('c1')).toBeUndefined();
      await expect(dir.lookup('c1')).rejects.toThrow('firestore unavailable');
      expect((await dir.lookup('c1'))?.childId).toBe('c1');
      await dir.lookup('c1');
    });
    expect(calls).toEqual(['c1', 'c1', 'c1']);
  });
});
