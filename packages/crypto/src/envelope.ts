import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import type { KeyWrapper } from './key-wrapper.js';

const FORMAT_VERSION = 1;
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export type WrappedDek = Buffer;

export class EnvelopeCipher {
  constructor(private readonly wrapper: KeyWrapper) {}

  async newChildKey(childId: string): Promise<{ dek: Buffer; wrappedDek: WrappedDek }> {
    const dek = randomBytes(DEK_BYTES);
    const wrappedDek = await this.wrapper.wrap(dek, childAad(childId));
    return { dek, wrappedDek };
  }

  unwrapChildKey(childId: string, wrappedDek: WrappedDek): Promise<Buffer> {
    return this.wrapper.unwrap(wrappedDek, childAad(childId));
  }

  encrypt(dek: Buffer, plaintext: string | Buffer, fieldAad: string): Buffer {
    assertDek(dek);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    cipher.setAAD(Buffer.from(fieldAad, 'utf8'));
    const input = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const body = Buffer.concat([cipher.update(input), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]);
  }

  decrypt(dek: Buffer, ciphertext: Buffer, fieldAad: string): Buffer {
    assertDek(dek);
    if (ciphertext.length < HEADER_BYTES) throw new Error('ciphertext too short');
    const version = ciphertext.readUInt8(0);
    if (version !== FORMAT_VERSION) throw new Error(`unsupported ciphertext version ${version}`);
    const iv = ciphertext.subarray(1, 1 + IV_BYTES);
    const tag = ciphertext.subarray(1 + IV_BYTES, HEADER_BYTES);
    const body = ciphertext.subarray(HEADER_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAAD(Buffer.from(fieldAad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }

  decryptText(dek: Buffer, ciphertext: Buffer, fieldAad: string): string {
    return this.decrypt(dek, ciphertext, fieldAad).toString('utf8');
  }
}

export function fieldAad(collectionPath: string, field: string): string {
  return `${collectionPath}#${field}`;
}

function childAad(childId: string): Buffer {
  return Buffer.from(`child:${childId}`, 'utf8');
}

function assertDek(dek: Buffer): void {
  if (dek.length !== DEK_BYTES) throw new Error(`DEK must be ${DEK_BYTES} bytes`);
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
