import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { signInWithCustomToken, signOut } from 'firebase/auth';
import { initializeApp } from 'firebase/app';
import { disableChildPush } from './push';
import { childFirebaseApp, signInPairedChild, signOutPairedChild } from './auth';

vi.mock('firebase/app', () => ({
  getApp: vi.fn(),
  getApps: () => [],
  initializeApp: vi.fn(() => ({ name: 'mamori-child' })),
}));
vi.mock('firebase/auth', () => ({
  getAuth: () => ({ name: 'test-auth' }),
  signInWithCustomToken: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
}));
vi.mock('./push', () => ({ disableChildPush: vi.fn(async () => {}) }));
beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ['API_KEY', 'PROJECT_ID', 'APP_ID', 'MESSAGING_SENDER_ID'])
    vi.stubEnv(`NEXT_PUBLIC_FIREBASE_${name}`, name);
});
afterEach(() => vi.unstubAllEnvs());
it('initializes one Firebase app with auth, App Check and messaging options', () => {
  childFirebaseApp();
  expect(initializeApp).toHaveBeenCalledWith(
    expect.objectContaining({
      apiKey: 'API_KEY',
      projectId: 'PROJECT_ID',
      appId: 'APP_ID',
      messagingSenderId: 'MESSAGING_SENDER_ID',
    }),
    'mamori-child',
  );
});
it('revokes the old push identity before replacing Firebase auth or logging out', async () => {
  await signInPairedChild('custom-token', 'c_new');
  expect(vi.mocked(disableChildPush).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(signInWithCustomToken).mock.invocationCallOrder[0]!,
  );
  await signOutPairedChild();
  expect(vi.mocked(disableChildPush).mock.invocationCallOrder[1]).toBeLessThan(
    vi.mocked(signOut).mock.invocationCallOrder[0]!,
  );
});
it('does not replace the old auth when revocation fails', async () => {
  vi.mocked(disableChildPush).mockRejectedValueOnce(new Error('offline'));
  await expect(signInPairedChild('custom-token', 'c_new')).rejects.toThrow('offline');
  expect(signInWithCustomToken).not.toHaveBeenCalled();
});
