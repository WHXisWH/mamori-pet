import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildApiError, childRequest } from './api';
import type * as ApiModule from './api';
import { childPushState, disableChildPush, enableChildPush, refreshChildPush } from './push';
import { deleteToken, getToken, isSupported } from 'firebase/messaging';

vi.mock('./api', async (original) => ({
  ...(await original<typeof ApiModule>()),
  childRequest: vi.fn(),
}));
vi.mock('./auth', () => ({ childFirebaseApp: () => ({ name: 'test' }) }));
vi.mock('firebase/messaging', () => ({
  isSupported: vi.fn(async () => true),
  getMessaging: vi.fn(() => ({})),
  getToken: vi.fn(async () => 'synthetic-token'),
  deleteToken: vi.fn(async () => true),
}));
const deviceId = 'a'.repeat(64);
const entries = new Map<string, string>();
const unsubscribe = vi.fn(async () => true);
const registration = { pushManager: { getSubscription: vi.fn(async () => ({ unsubscribe })) } };
let permission: NotificationPermission;
const requestPermission = vi.fn(async () => {
  permission = 'granted';
  return permission;
});
const cache = {
  match: vi.fn(async (key: string) =>
    entries.has(key) ? new Response(entries.get(key)!) : undefined,
  ),
  put: vi.fn(async (key: string, response: Response) => {
    entries.set(key, await response.text());
  }),
  delete: vi.fn(async (key: string) => entries.delete(key)),
};

beforeEach(() => {
  vi.clearAllMocks();
  entries.clear();
  permission = 'default';
  for (const name of ['API_KEY', 'PROJECT_ID', 'APP_ID', 'MESSAGING_SENDER_ID', 'VAPID_KEY'])
    vi.stubEnv(`NEXT_PUBLIC_FIREBASE_${name}`, 'synthetic');
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    get permission() {
      return permission;
    },
    requestPermission,
  });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve(registration),
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
    },
  });
  requestPermission.mockImplementation(async () => {
    permission = 'granted';
    return permission;
  });
  vi.mocked(childRequest).mockResolvedValue({ deviceId });
  vi.mocked(isSupported).mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('child push lifecycle', () => {
  it('does not request permission, create a token or call the API on status/refresh before opt-in', async () => {
    expect(await childPushState('c1')).toBe('off');
    await refreshChildPush('c1');
    expect(requestPermission).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
    expect(childRequest).not.toHaveBeenCalled();
  });
  it('requests permission synchronously in the gesture, then registers with the existing worker', async () => {
    const pending = enableChildPush('c1');
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(await pending).toBe('on');
    expect(getToken).toHaveBeenCalledWith(
      {},
      { vapidKey: 'synthetic', serviceWorkerRegistration: registration },
    );
    expect(childRequest).toHaveBeenCalledWith('/v1/child/devices', {
      method: 'POST',
      body: JSON.stringify({ fcmToken: 'synthetic-token', platform: 'desktop' }),
    });
    expect(await childPushState('c1')).toBe('on');
    expect([...entries.values()].join()).not.toContain('synthetic-token');
  });
  it('shows denied, unconfigured and unsupported states without token registration', async () => {
    permission = 'denied';
    expect(await enableChildPush('c1')).toBe('denied');
    expect(await childPushState('c1')).toBe('denied');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_VAPID_KEY', '');
    expect(await enableChildPush('c1')).toBe('unconfigured');
    vi.stubEnv('NEXT_PUBLIC_FIREBASE_VAPID_KEY', 'synthetic');
    vi.mocked(isSupported).mockResolvedValue(false);
    expect(await childPushState('c1')).toBe('unsupported');
    expect(getToken).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it('refreshes only an existing opt-in, revoking the old token id after rotation', async () => {
    await enableChildPush('c1');
    vi.mocked(childRequest).mockResolvedValue({ deviceId: 'b'.repeat(64) });
    await refreshChildPush('c1');
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(childRequest).toHaveBeenLastCalledWith(`/v1/child/devices/${deviceId}`, {
      method: 'DELETE',
    });
  });
  it('disables backend routing and browser subscription before forgetting the identity', async () => {
    await enableChildPush('c1');
    await disableChildPush();
    expect(childRequest).toHaveBeenLastCalledWith(`/v1/child/devices/${deviceId}`, {
      method: 'DELETE',
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(deleteToken).toHaveBeenCalledOnce();
    expect(entries.size).toBe(0);
    expect(await childPushState('c1')).toBe('off');
  });
  it('keeps failed revocation retryable without leaving background display enabled', async () => {
    await enableChildPush('c1');
    vi.mocked(childRequest).mockRejectedValueOnce(new Error('offline'));
    await expect(disableChildPush()).rejects.toThrow('offline');
    expect(entries.has('/__child-push-binding')).toBe(false);
    expect(unsubscribe).toHaveBeenCalled();
    await disableChildPush();
    expect(entries.size).toBe(0);
  });
  it('never opts in a different child when an old persisted binding is found', async () => {
    await enableChildPush('c1');
    vi.mocked(getToken).mockClear();
    await refreshChildPush('c2');
    expect(getToken).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalled();
    expect(entries.size).toBe(0);
  });
  it('allows re-pair after auth expiry only after revoking the local push subscription', async () => {
    await enableChildPush('c1');
    vi.mocked(childRequest).mockRejectedValueOnce(new ChildApiError('UNAUTHENTICATED', 401));
    await expect(disableChildPush()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(entries.size).toBe(0);
  });
  it('does not allow re-pair when both backend auth and browser revocation fail', async () => {
    await enableChildPush('c1');
    vi.mocked(childRequest).mockRejectedValueOnce(new ChildApiError('UNAUTHENTICATED', 401));
    unsubscribe.mockResolvedValueOnce(false);
    await expect(disableChildPush()).rejects.toThrow('push_unsubscribe_failed');
    expect(entries.has('/__child-push-binding')).toBe(false);
    expect(entries.has('/__child-push-revoke')).toBe(true);
    await disableChildPush();
  });
  it('does not claim success or enable the worker after backend registration fails', async () => {
    vi.mocked(childRequest).mockRejectedValueOnce(new Error('rejected'));
    await expect(enableChildPush('c1')).rejects.toThrow('rejected');
    expect(entries.size).toBe(0);
    expect(await childPushState('c1')).toBe('off');
  });
});
