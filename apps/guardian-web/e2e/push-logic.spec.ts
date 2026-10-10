import type { DeviceReq } from '@ijime/api-types';
import { expect, test } from '@playwright/test';

import {
  platformOf,
  pushConfigured,
  pushState,
  registerPush,
  type BrowserFacts,
  type PushDriver,
} from '../src/lib/push';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

const base: BrowserFacts = {
  configured: true,
  ios: false,
  standalone: false,
  hasNotification: true,
  hasServiceWorker: true,
  hasPushManager: true,
  permission: 'default',
};

function driver(
  permission: NotificationPermission,
  token: () => Promise<string> = async () => 'fcm-token',
) {
  const calls = { permission: 0, token: 0 };
  const d: PushDriver = {
    async requestPermission() {
      calls.permission += 1;
      return permission;
    },
    async token() {
      calls.token += 1;
      return token();
    },
  };
  return { d, calls };
}

test.describe('push decision logic', () => {
  test('platform detection covers iPhone, iPad desktop mode, Android and desktop', () => {
    expect(platformOf(IPHONE)).toBe('ios_pwa');
    expect(platformOf(IPAD_DESKTOP, 5)).toBe('ios_pwa');
    expect(platformOf(IPAD_DESKTOP, 0)).toBe('desktop');
    expect(platformOf(ANDROID)).toBe('android');
  });

  test('FCM counts as configured only with every key present', () => {
    const full = { apiKey: 'k', projectId: 'p', appId: 'a', senderId: 's', vapidKey: 'v' };
    expect(pushConfigured(full)).toBe(true);
    expect(pushConfigured({ ...full, vapidKey: '' })).toBe(false);
    expect(pushConfigured({ ...full, senderId: undefined })).toBe(false);
  });

  test('iOS Safari outside the home screen is asked to install first', () => {
    expect(pushState({ ...base, ios: true })).toBe('needs_install');
    expect(pushState({ ...base, ios: true, configured: false })).toBe('needs_install');
    expect(pushState({ ...base, ios: true, standalone: true })).toBe('prompt');
  });

  test('state follows configuration, capability and permission', () => {
    expect(pushState({ ...base, configured: false })).toBe('unconfigured');
    expect(pushState({ ...base, hasPushManager: false })).toBe('unsupported');
    expect(pushState({ ...base, permission: 'denied' })).toBe('denied');
    expect(pushState({ ...base, permission: 'granted' })).toBe('granted');
    expect(pushState(base)).toBe('prompt');
  });

  test('a granted permission posts the token with the platform', async () => {
    const posted: DeviceReq[] = [];
    const { d } = driver('granted');
    const r = await registerPush(d, async (b) => posted.push(b), 'ios_pwa');
    expect(r).toBe('registered');
    expect(posted).toEqual([{ fcmToken: 'fcm-token', platform: 'ios_pwa' }]);
  });

  test('a refused permission never requests a token or posts', async () => {
    const posted: DeviceReq[] = [];
    const { d, calls } = driver('denied');
    expect(await registerPush(d, async (b) => posted.push(b), 'android')).toBe('denied');
    expect(calls.token).toBe(0);
    expect(posted).toEqual([]);
  });

  test('token or API failures report failed', async () => {
    const reject = driver('granted', async () => {
      throw new Error('messaging/token-subscribe-failed');
    });
    expect(await registerPush(reject.d, async () => undefined, 'desktop')).toBe('failed');
    const empty = driver('granted', async () => '');
    expect(await registerPush(empty.d, async () => undefined, 'desktop')).toBe('failed');
    const ok = driver('granted');
    const r = await registerPush(
      ok.d,
      async () => {
        throw new Error('503');
      },
      'desktop',
    );
    expect(r).toBe('failed');
  });

  test('silent re-registration skips the permission prompt', async () => {
    const posted: DeviceReq[] = [];
    const { d, calls } = driver('default');
    const r = await registerPush(d, async (b) => posted.push(b), 'android', {
      askPermission: false,
    });
    expect(r).toBe('registered');
    expect(calls.permission).toBe(0);
    expect(posted).toHaveLength(1);
  });
});
