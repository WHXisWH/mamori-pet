import { LocalKeyWrapper, type KeyWrapper } from './key-wrapper.js';

// OAuth のリフレッシュトークンは KMS の tokens 鍵で直接暗号化する（トークンは短いのでエンベロープ暗号化は不要）。AAD にはドキュメントパスとフィールドを結び付ける
export class TokenVault {
  constructor(private readonly wrapper: KeyWrapper) {}

  // ローカルとエミュレーター専用。api と calendar-sync は同じ開発用の鍵を使うこと
  static dev(): TokenVault {
    return new TokenVault(new LocalKeyWrapper(Buffer.alloc(32, 9)));
  }

  async seal(token: string, aad: string): Promise<Buffer> {
    if (!token) throw new Error('empty token');
    return this.wrapper.wrap(Buffer.from(token, 'utf8'), Buffer.from(aad, 'utf8'));
  }

  async open(sealed: Buffer | Uint8Array, aad: string): Promise<string> {
    const plain = await this.wrapper.unwrap(Buffer.from(sealed), Buffer.from(aad, 'utf8'));
    return plain.toString('utf8');
  }
}
