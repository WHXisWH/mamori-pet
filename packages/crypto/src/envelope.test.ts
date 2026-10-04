import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { EnvelopeCipher, fieldAad } from './envelope.js';
import {
  KmsKeyWrapper,
  KmsPseudonymizer,
  LocalKeyWrapper,
  LocalPseudonymizer,
  kmsKeyPath,
} from './key-wrapper.js';

const CHILD = 'c_41a7';
const AAD = fieldAad('families/f_1/children/c_41a7/sessions/s_1/messages', 'contentEnc');

describe('EnvelopeCipher with LocalKeyWrapper', () => {
  const cipher = new EnvelopeCipher(new LocalKeyWrapper());

  it('round-trips Japanese text', async () => {
    const { dek, wrappedDek } = await cipher.newChildKey(CHILD);
    const ct = cipher.encrypt(dek, 'きょう、みんなに むしされた', AAD);
    const dek2 = await cipher.unwrapChildKey(CHILD, wrappedDek);
    expect(dek2.equals(dek)).toBe(true);
    expect(cipher.decryptText(dek2, ct, AAD)).toBe('きょう、みんなに むしされた');
  });

  it('produces different ciphertext for the same plaintext', async () => {
    const { dek } = await cipher.newChildKey(CHILD);
    const a = cipher.encrypt(dek, 'x', AAD);
    const b = cipher.encrypt(dek, 'x', AAD);
    expect(a.equals(b)).toBe(false);
  });

  it('never contains the plaintext', async () => {
    const { dek } = await cipher.newChildKey(CHILD);
    const ct = cipher.encrypt(dek, 'ハブられた', AAD);
    expect(ct.toString('utf8')).not.toContain('ハブられた');
    expect(ct.readUInt8(0)).toBe(1);
  });

  it('rejects tampered ciphertext', async () => {
    const { dek } = await cipher.newChildKey(CHILD);
    const ct = cipher.encrypt(dek, 'hello', AAD);
    ct[ct.length - 1]! ^= 0x01;
    expect(() => cipher.decrypt(dek, ct, AAD)).toThrow();
  });

  it('rejects a wrong field AAD', async () => {
    const { dek } = await cipher.newChildKey(CHILD);
    const ct = cipher.encrypt(dek, 'hello', AAD);
    expect(() => cipher.decrypt(dek, ct, fieldAad('other', 'contentEnc'))).toThrow();
  });

  it('rejects the wrong DEK', async () => {
    const a = await cipher.newChildKey(CHILD);
    const b = await cipher.newChildKey('c_other');
    const ct = cipher.encrypt(a.dek, 'hello', AAD);
    expect(() => cipher.decrypt(b.dek, ct, AAD)).toThrow();
  });

  it('binds the wrapped DEK to the child id', async () => {
    const { wrappedDek } = await cipher.newChildKey(CHILD);
    await expect(cipher.unwrapChildKey('c_other', wrappedDek)).rejects.toThrow();
  });

  it('rejects malformed input', async () => {
    const { dek } = await cipher.newChildKey(CHILD);
    expect(() => cipher.decrypt(dek, Buffer.from([1, 2, 3]), AAD)).toThrow(/too short/);
    const ct = cipher.encrypt(dek, 'hello', AAD);
    ct[0] = 9;
    expect(() => cipher.decrypt(dek, ct, AAD)).toThrow(/version/);
    expect(() => cipher.encrypt(randomBytes(16), 'x', AAD)).toThrow(/32 bytes/);
    expect(() => new LocalKeyWrapper(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe('KmsKeyWrapper', () => {
  const store = new Map<string, Buffer>();
  const fakeKms = {
    async encrypt(req: {
      name: string;
      plaintext: Uint8Array;
      additionalAuthenticatedData?: Uint8Array;
    }) {
      const id = randomBytes(8).toString('hex');
      store.set(
        `${id}|${Buffer.from(req.additionalAuthenticatedData ?? []).toString('hex')}`,
        Buffer.from(req.plaintext),
      );
      return [{ ciphertext: Buffer.from(id) }] as [{ ciphertext: Buffer }];
    },
    async decrypt(req: {
      name: string;
      ciphertext: Uint8Array;
      additionalAuthenticatedData?: Uint8Array;
    }) {
      const key = `${Buffer.from(req.ciphertext).toString()}|${Buffer.from(req.additionalAuthenticatedData ?? []).toString('hex')}`;
      const pt = store.get(key);
      if (!pt) throw new Error('decrypt failed');
      return [{ plaintext: pt }] as [{ plaintext: Buffer }];
    },
    async macSign(req: { name: string; data: Uint8Array }) {
      return [{ mac: Buffer.from(req.data).toString('base64') }] as [{ mac: string }];
    },
  };

  it('delegates wrap and unwrap to KMS with AAD', async () => {
    const cipher = new EnvelopeCipher(
      new KmsKeyWrapper(fakeKms, 'projects/p/locations/l/keyRings/r/cryptoKeys/content'),
    );
    const { dek, wrappedDek } = await cipher.newChildKey(CHILD);
    expect((await cipher.unwrapChildKey(CHILD, wrappedDek)).equals(dek)).toBe(true);
    await expect(cipher.unwrapChildKey('c_other', wrappedDek)).rejects.toThrow();
  });

  it('builds key paths and pseudonyms', async () => {
    expect(
      kmsKeyPath({ projectId: 'p', location: 'asia-northeast1', keyRing: 'ijime', key: 'content' }),
    ).toBe('projects/p/locations/asia-northeast1/keyRings/ijime/cryptoKeys/content');
    const p = new KmsPseudonymizer(fakeKms, 'x/cryptoKeyVersions/1');
    const a = await p.pseudonymize(CHILD);
    expect(a).toMatch(/^p_[0-9a-f]+$/);
    expect(await p.pseudonymize(CHILD)).toBe(a);
  });

  it('fails clearly on empty KMS responses', async () => {
    const empty = {
      ...fakeKms,
      async decrypt() {
        return [{ plaintext: null }] as [{ plaintext: null }];
      },
    };
    const w = new KmsKeyWrapper(empty, 'k');
    await expect(w.unwrap(Buffer.from('x'), Buffer.from('a'))).rejects.toThrow(/empty plaintext/);
  });
});

describe('LocalPseudonymizer', () => {
  it('is deterministic per secret and never echoes input', async () => {
    const secret = randomBytes(32);
    const a = new LocalPseudonymizer(secret);
    const b = new LocalPseudonymizer(secret);
    const c = new LocalPseudonymizer();
    expect(await a.pseudonymize(CHILD)).toBe(await b.pseudonymize(CHILD));
    expect(await a.pseudonymize(CHILD)).not.toBe(await c.pseudonymize(CHILD));
    expect(await a.pseudonymize(CHILD)).not.toContain(CHILD);
  });
});
