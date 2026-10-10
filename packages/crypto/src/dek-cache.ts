import { createHash } from 'node:crypto';

import type { KeyWrapper } from './key-wrapper.js';

export type DekCacheOptions = {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
};

type Entry = { dek: Promise<Buffer>; expiresAt: number };

// アンラップ済みの DEK はプロセスのメモリにだけ置き、「ラップ済みの暗号文 + AAD」のダイジェストをキーにする。鍵をラップし直す（ローテーション）とキーも変わり、
// AAD が違えば必ずミスして下層の検証に回る。ヒット時はコピーを返すので、呼び出し側が書き換えてもキャッシュには影響しない。ディスクに書かず、ログにも残さない。
export class CachingKeyWrapper implements KeyWrapper {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(
    private readonly inner: KeyWrapper,
    private readonly opts: DekCacheOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  wrap(dek: Buffer, aad: Buffer): Promise<Buffer> {
    return this.inner.wrap(dek, aad);
  }

  async unwrap(wrapped: Buffer, aad: Buffer): Promise<Buffer> {
    const key = createHash('sha256')
      .update(String(aad.length))
      .update(':')
      .update(aad)
      .update(wrapped)
      .digest('base64');
    const now = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) {
      // 入れ直す。Map の挿入順がそのまま最近使った順になる
      this.entries.delete(key);
      this.entries.set(key, hit);
      return Buffer.from(await hit.dek);
    }
    if (hit) this.entries.delete(key);
    const dek = this.inner.unwrap(wrapped, aad);
    this.entries.set(key, { dek, expiresAt: now + this.opts.ttlMs });
    this.evict();
    try {
      return Buffer.from(await dek);
    } catch (err) {
      if (this.entries.get(key)?.dek === dek) this.entries.delete(key);
      throw err;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(): void {
    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}
