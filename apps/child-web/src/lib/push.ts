import type { DeviceReq, DeviceRes } from '@ijime/api-types';
import { ChildApiError, childRequest } from './api';
import { childFirebaseApp } from './auth';

export type ChildPushState = 'unconfigured' | 'unsupported' | 'denied' | 'off' | 'on';
type Binding = { childId: string; deviceId: string };
const CACHE = 'child-push-v1';
const BINDING = '/__child-push-binding';
let pending: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = pending.catch(() => {}).then(work);
  pending = next;
  return next;
}

function configured(): boolean {
  return !!(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID &&
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID &&
    process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY
  );
}

async function binding(path = BINDING): Promise<Binding | undefined> {
  if (typeof window === 'undefined' || !('caches' in window)) return undefined;
  const response = await (await caches.open(CACHE)).match(path);
  if (!response) return undefined;
  const value = (await response.json()) as Partial<Binding>;
  return typeof value.childId === 'string' && /^[a-f0-9]{64}$/.test(value.deviceId ?? '')
    ? (value as Binding)
    : undefined;
}

async function forgetBinding(): Promise<void> {
  if (typeof window !== 'undefined' && 'caches' in window)
    await (await caches.open(CACHE)).delete(BINDING);
}

export async function childPushState(childId: string): Promise<ChildPushState> {
  if (!configured()) return 'unconfigured';
  if (
    typeof window === 'undefined' ||
    !window.isSecureContext ||
    !('Notification' in window) ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('caches' in window) ||
    !(await (await import('firebase/messaging')).isSupported())
  )
    return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const current = await binding();
  return Notification.permission === 'granted' && current?.childId === childId ? 'on' : 'off';
}

function platform(): DeviceReq['platform'] {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios ? 'ios_pwa' : /Android/.test(navigator.userAgent) ? 'android' : 'desktop';
}

async function register(childId: string): Promise<void> {
  const app = childFirebaseApp();
  if (!app || !childId || Notification.permission !== 'granted')
    throw new Error('push_unavailable');
  const sdk = await import('firebase/messaging');
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const registration = await navigator.serviceWorker.ready;
  const messaging = sdk.getMessaging(app);
  const token = await sdk.getToken(messaging, {
    vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY!,
    serviceWorkerRegistration: registration,
  });
  if (!token) throw new Error('push_unavailable');
  const old = await binding();
  if (old && old.childId !== childId) throw new Error('push_identity_changed');
  const result = await childRequest<DeviceRes>('/v1/child/devices', {
    method: 'POST',
    body: JSON.stringify({ fcmToken: token, platform: platform() } satisfies DeviceReq),
  });
  // Save only routing identifiers, never the FCM token or any child content.
  await (
    await caches.open(CACHE)
  ).put(
    BINDING,
    new Response(JSON.stringify({ childId, deviceId: result.deviceId } satisfies Binding)),
  );
  if (old && old.deviceId !== result.deviceId)
    await childRequest(`/v1/child/devices/${old.deviceId}`, { method: 'DELETE' });
}

/** Call directly from a click/change handler: Safari requires a live user gesture. */
export function enableChildPush(childId: string): Promise<ChildPushState> {
  if (!configured()) return Promise.resolve('unconfigured');
  if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
  const permission =
    Notification.permission === 'default'
      ? Notification.requestPermission()
      : Promise.resolve(Notification.permission);
  return serialize(async () => {
    if ((await permission) !== 'granted')
      return Notification.permission === 'denied' ? 'denied' : 'off';
    const state = await childPushState(childId);
    if (state === 'unsupported' || state === 'unconfigured') return state;
    await register(childId);
    return 'on';
  });
}

/** Refresh an existing opt-in; never request permission or opt a new identity in. */
export function refreshChildPush(childId: string): Promise<void> {
  return serialize(async () => {
    if (await binding('/__child-push-revoke')) {
      await revoke();
      return;
    }
    const current = await binding();
    if (!current) return;
    if (current.childId !== childId || !childId) {
      await forgetBinding();
      const registration = await navigator.serviceWorker.getRegistration('/');
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
      return;
    }
    if (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted' &&
      configured()
    )
      await register(childId);
    else {
      await childRequest(`/v1/child/devices/${current.deviceId}`, { method: 'DELETE' });
      await forgetBinding();
    }
  });
}

/** Must complete while the old auth identity is still active, before sign-out/re-pair. */
export function disableChildPush(): Promise<void> {
  return serialize(revoke);
}

async function revoke(): Promise<void> {
  const current = (await binding()) ?? (await binding('/__child-push-revoke'));
  if (!current) return;
  // Remove the display permission locally first; queued pushes cannot cross an account switch.
  await forgetBinding();
  let failure: unknown;
  let unsubscribeFailed = false;
  try {
    await childRequest(`/v1/child/devices/${current.deviceId}`, { method: 'DELETE' });
    await (await caches.open(CACHE)).delete('/__child-push-revoke');
  } catch (error) {
    // Retain revocation metadata, but never re-enable background display after a failure.
    await (
      await caches.open(CACHE)
    ).put('/__child-push-revoke', new Response(JSON.stringify(current)));
    failure = error;
  } finally {
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      unsubscribeFailed = !!subscription && !(await subscription.unsubscribe());
    } catch {
      unsubscribeFailed = true;
    }
    if (configured()) {
      const app = childFirebaseApp();
      if (app) {
        const sdk = await import('firebase/messaging');
        await sdk.deleteToken(sdk.getMessaging(app)).catch(() => {});
      }
    }
  }
  if (unsubscribeFailed) throw new Error('push_unsubscribe_failed');
  if (failure instanceof ChildApiError && [401, 403, 404].includes(failure.status)) {
    // Expired/revoked auth must not trap a child outside pairing. The worker is off and the
    // browser subscription is now revoked; the sender prunes the resulting stale token.
    await (await caches.open(CACHE)).delete('/__child-push-revoke');
  } else if (failure) throw failure;
}
