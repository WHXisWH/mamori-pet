import { describe, expect, it } from 'vitest';

import { fieldAad } from './envelope.js';
import { LocalKeyWrapper } from './key-wrapper.js';
import { TokenVault } from './token-vault.js';

const AAD = fieldAad('families/f_1/calendarConnections', 'g_1#refreshTokenEnc');
const TOKEN = '1//0e-refresh-token-sample';

describe('TokenVault', () => {
  it('round-trips a refresh token and never stores it in clear', async () => {
    const vault = new TokenVault(new LocalKeyWrapper());
    const sealed = await vault.seal(TOKEN, AAD);
    expect(sealed.toString('utf8')).not.toContain(TOKEN);
    expect(await vault.open(sealed, AAD)).toBe(TOKEN);
  });

  it('rejects a token sealed for another document', async () => {
    const vault = new TokenVault(new LocalKeyWrapper());
    const sealed = await vault.seal(TOKEN, AAD);
    await expect(vault.open(sealed, AAD.replace('g_1', 'g_2'))).rejects.toThrow();
  });

  it('rejects tampered ciphertext', async () => {
    const vault = new TokenVault(new LocalKeyWrapper());
    const sealed = await vault.seal(TOKEN, AAD);
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
    await expect(vault.open(sealed, AAD)).rejects.toThrow();
  });

  it('dev vaults share one key so api and calendar-sync interoperate locally', async () => {
    const sealed = await TokenVault.dev().seal(TOKEN, AAD);
    expect(await TokenVault.dev().open(sealed, AAD)).toBe(TOKEN);
  });

  it('refuses to seal an empty token', async () => {
    await expect(new TokenVault(new LocalKeyWrapper()).seal('', AAD)).rejects.toThrow();
  });
});
