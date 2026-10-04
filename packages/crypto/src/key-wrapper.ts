import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

export interface KeyWrapper {
  wrap(dek: Buffer, aad: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer, aad: Buffer): Promise<Buffer>;
}

export interface Pseudonymizer {
  pseudonymize(input: string): Promise<string>;
}

export type KmsKeyName = {
  projectId: string;
  location: string;
  keyRing: string;
  key: string;
};

export function kmsKeyPath(k: KmsKeyName): string {
  return `projects/${k.projectId}/locations/${k.location}/keyRings/${k.keyRing}/cryptoKeys/${k.key}`;
}

type KmsClientLike = {
  encrypt(req: {
    name: string;
    plaintext: Uint8Array;
    additionalAuthenticatedData?: Uint8Array;
  }): Promise<[{ ciphertext?: Uint8Array | string | null }]>;
  decrypt(req: {
    name: string;
    ciphertext: Uint8Array;
    additionalAuthenticatedData?: Uint8Array;
  }): Promise<[{ plaintext?: Uint8Array | string | null }]>;
  macSign(req: { name: string; data: Uint8Array }): Promise<[{ mac?: Uint8Array | string | null }]>;
};

function toBuffer(v: Uint8Array | string | null | undefined, what: string): Buffer {
  if (v == null) throw new Error(`KMS returned empty ${what}`);
  return typeof v === 'string' ? Buffer.from(v, 'base64') : Buffer.from(v);
}

export class KmsKeyWrapper implements KeyWrapper {
  constructor(
    private readonly client: KmsClientLike,
    private readonly keyName: string,
  ) {}

  async wrap(dek: Buffer, aad: Buffer): Promise<Buffer> {
    const [res] = await this.client.encrypt({
      name: this.keyName,
      plaintext: dek,
      additionalAuthenticatedData: aad,
    });
    return toBuffer(res.ciphertext, 'ciphertext');
  }

  async unwrap(wrapped: Buffer, aad: Buffer): Promise<Buffer> {
    const [res] = await this.client.decrypt({
      name: this.keyName,
      ciphertext: wrapped,
      additionalAuthenticatedData: aad,
    });
    return toBuffer(res.plaintext, 'plaintext');
  }
}

export class KmsPseudonymizer implements Pseudonymizer {
  constructor(
    private readonly client: KmsClientLike,
    private readonly keyVersionName: string,
  ) {}

  async pseudonymize(input: string): Promise<string> {
    const [res] = await this.client.macSign({
      name: this.keyVersionName,
      data: Buffer.from(input, 'utf8'),
    });
    return `p_${toBuffer(res.mac, 'mac').toString('hex').slice(0, 32)}`;
  }
}

const LOCAL_IV_BYTES = 12;
const LOCAL_TAG_BYTES = 16;

export class LocalKeyWrapper implements KeyWrapper {
  private readonly kek: Buffer;

  constructor(kek?: Buffer) {
    if (kek && kek.length !== 32) throw new Error('local KEK must be 32 bytes');
    this.kek = kek ?? randomBytes(32);
  }

  async wrap(dek: Buffer, aad: Buffer): Promise<Buffer> {
    const iv = randomBytes(LOCAL_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  async unwrap(wrapped: Buffer, aad: Buffer): Promise<Buffer> {
    if (wrapped.length < LOCAL_IV_BYTES + LOCAL_TAG_BYTES) throw new Error('wrapped key too short');
    const iv = wrapped.subarray(0, LOCAL_IV_BYTES);
    const tag = wrapped.subarray(LOCAL_IV_BYTES, LOCAL_IV_BYTES + LOCAL_TAG_BYTES);
    const body = wrapped.subarray(LOCAL_IV_BYTES + LOCAL_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  }
}

export class LocalPseudonymizer implements Pseudonymizer {
  constructor(private readonly secret: Buffer = randomBytes(32)) {}

  async pseudonymize(input: string): Promise<string> {
    const mac = createHmac('sha256', this.secret).update(input, 'utf8').digest('hex');
    return `p_${mac.slice(0, 32)}`;
  }
}
