import { describe, expect, it } from 'vitest';

import { CachingKeyWrapper } from './dek-cache.js';
import { EnvelopeCipher } from './envelope.js';
import { LocalKeyWrapper, type KeyWrapper } from './key-wrapper.js';

class Counting implements KeyWrapper {
  unwraps = 0;
  fail = false;
  readonly inner = new LocalKeyWrapper(Buffer.alloc(32, 3));
  wrap(dek: Buffer, aad: Buffer) {
    return this.inner.wrap(dek, aad);
  }
  async unwrap(wrapped: Buffer, aad: Buffer) {
    this.unwraps++;
    if (this.fail) throw new Error('kms unavailable');
    return this.inner.unwrap(wrapped, aad);
  }
}

function setup(opts: { ttlMs?: number; maxEntries?: number } = {}) {
  const inner = new Counting();
  let t = 1_000;
  const cache = new CachingKeyWrapper(inner, {
    ttlMs: opts.ttlMs ?? 60_000,
    maxEntries: opts.maxEntries ?? 10,
    now: () => t,
  });
  const cipher = new EnvelopeCipher(cache);
  return { inner, cache, cipher, tick: (ms: number) => (t += ms) };
}

describe('CachingKeyWrapper', () => {
  it('unwraps once, then serves copies from memory', async () => {
    const { inner, cipher } = setup();
    const { dek, wrappedDek } = await cipher.newChildKey('c1');
    const a = await cipher.unwrapChildKey('c1', wrappedDek);
    const b = await cipher.unwrapChildKey('c1', wrappedDek);
    expect(a.equals(dek) && b.equals(dek)).toBe(true);
    expect(inner.unwraps).toBe(1);
    a.fill(0);
    expect((await cipher.unwrapChildKey('c1', wrappedDek)).equals(dek)).toBe(true);
  });

  it('shares one KMS call between concurrent requests', async () => {
    const { inner, cipher } = setup();
    const { wrappedDek } = await cipher.newChildKey('c1');
    await Promise.all([1, 2, 3].map(() => cipher.unwrapChildKey('c1', wrappedDek)));
    expect(inner.unwraps).toBe(1);
  });

  it('expires entries after the TTL', async () => {
    const { inner, cipher, tick } = setup({ ttlMs: 100 });
    const { wrappedDek } = await cipher.newChildKey('c1');
    await cipher.unwrapChildKey('c1', wrappedDek);
    tick(99);
    await cipher.unwrapChildKey('c1', wrappedDek);
    expect(inner.unwraps).toBe(1);
    tick(1);
    await cipher.unwrapChildKey('c1', wrappedDek);
    expect(inner.unwraps).toBe(2);
  });

  it('evicts the least recently used entry beyond capacity', async () => {
    const { inner, cache, cipher } = setup({ maxEntries: 2 });
    const k1 = await cipher.newChildKey('c1');
    const k2 = await cipher.newChildKey('c2');
    const k3 = await cipher.newChildKey('c3');
    await cipher.unwrapChildKey('c1', k1.wrappedDek);
    await cipher.unwrapChildKey('c2', k2.wrappedDek);
    await cipher.unwrapChildKey('c1', k1.wrappedDek);
    await cipher.unwrapChildKey('c3', k3.wrappedDek);
    expect(cache.size).toBe(2);
    expect(inner.unwraps).toBe(3);
    await cipher.unwrapChildKey('c1', k1.wrappedDek);
    expect(inner.unwraps).toBe(3);
    await cipher.unwrapChildKey('c2', k2.wrappedDek);
    expect(inner.unwraps).toBe(4);
  });

  it('a different AAD (another child) never hits the cache and still fails', async () => {
    const { inner, cipher } = setup();
    const { wrappedDek } = await cipher.newChildKey('c1');
    await cipher.unwrapChildKey('c1', wrappedDek);
    await expect(cipher.unwrapChildKey('c2', wrappedDek)).rejects.toThrow();
    expect(inner.unwraps).toBe(2);
  });

  it('a rewrapped (rotated) key is a different entry', async () => {
    const { inner, cipher } = setup();
    const first = await cipher.newChildKey('c1');
    const second = await cipher.newChildKey('c1');
    expect((await cipher.unwrapChildKey('c1', first.wrappedDek)).equals(first.dek)).toBe(true);
    expect((await cipher.unwrapChildKey('c1', second.wrappedDek)).equals(second.dek)).toBe(true);
    expect(inner.unwraps).toBe(2);
  });

  it('does not cache failures', async () => {
    const { inner, cache, cipher } = setup();
    const { wrappedDek } = await cipher.newChildKey('c1');
    inner.fail = true;
    await expect(cipher.unwrapChildKey('c1', wrappedDek)).rejects.toThrow('kms unavailable');
    expect(cache.size).toBe(0);
    inner.fail = false;
    await cipher.unwrapChildKey('c1', wrappedDek);
    expect(inner.unwraps).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
