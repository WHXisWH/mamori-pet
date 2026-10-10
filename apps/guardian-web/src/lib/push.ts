import type { DeviceReq } from '@ijime/api-types';

// Decision logic stays free of browser globals so it can run without a browser.

export type PushEnv = {
  apiKey?: string | undefined;
  projectId?: string | undefined;
  appId?: string | undefined;
  senderId?: string | undefined;
  vapidKey?: string | undefined;
};

export function pushEnv(): PushEnv {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    senderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
  };
}

export function pushConfigured(env: PushEnv): boolean {
  return !!(env.apiKey && env.projectId && env.appId && env.senderId && env.vapidKey);
}

export type Platform = DeviceReq['platform'];

export function isIos(ua: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

export function platformOf(ua: string, maxTouchPoints = 0): Platform {
  if (isIos(ua, maxTouchPoints)) return 'ios_pwa';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

export type PushState =
  'unconfigured' | 'needs_install' | 'unsupported' | 'denied' | 'prompt' | 'granted';

export type BrowserFacts = {
  configured: boolean;
  ios: boolean;
  standalone: boolean;
  hasNotification: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  permission: NotificationPermission | undefined;
};

// iOS delivers web push only to PWAs added to the home screen.
export function pushState(f: BrowserFacts): PushState {
  if (f.ios && !f.standalone) return 'needs_install';
  if (!f.configured) return 'unconfigured';
  if (!f.hasNotification || !f.hasServiceWorker || !f.hasPushManager) return 'unsupported';
  if (f.permission === 'denied') return 'denied';
  if (f.permission === 'granted') return 'granted';
  return 'prompt';
}

export function browserFacts(env: PushEnv = pushEnv()): BrowserFacts {
  const nav = navigator as Navigator & { standalone?: boolean };
  return {
    configured: pushConfigured(env),
    ios: isIos(nav.userAgent, nav.maxTouchPoints),
    standalone: window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
    hasNotification: 'Notification' in window,
    hasServiceWorker: 'serviceWorker' in nav,
    hasPushManager: 'PushManager' in window,
    permission: 'Notification' in window ? Notification.permission : undefined,
  };
}

export type PushDriver = {
  requestPermission(): Promise<NotificationPermission>;
  token(): Promise<string>;
};

export type RegisterResult = 'registered' | 'denied' | 'failed';

export async function registerPush(
  driver: PushDriver,
  post: (body: DeviceReq) => Promise<unknown>,
  platform: Platform,
  opts: { askPermission: boolean } = { askPermission: true },
): Promise<RegisterResult> {
  if (opts.askPermission) {
    const permission = await driver.requestPermission();
    if (permission !== 'granted') return 'denied';
  }
  let token: string;
  try {
    token = await driver.token();
  } catch {
    return 'failed';
  }
  if (!token) return 'failed';
  try {
    await post({ fcmToken: token, platform });
  } catch {
    return 'failed';
  }
  return 'registered';
}

export function firebaseDriver(env: PushEnv): PushDriver {
  return {
    requestPermission: () => Notification.requestPermission(),
    async token() {
      const [{ getApp, getApps, initializeApp }, { getMessaging, getToken }] = await Promise.all([
        import('firebase/app'),
        import('firebase/messaging'),
      ]);
      const name = 'mamori-guardian-push';
      const app = getApps().some((a) => a.name === name)
        ? getApp(name)
        : initializeApp(
            {
              apiKey: env.apiKey!,
              projectId: env.projectId!,
              appId: env.appId!,
              messagingSenderId: env.senderId!,
            },
            name,
          );
      return getToken(getMessaging(app), {
        vapidKey: env.vapidKey!,
        serviceWorkerRegistration: await navigator.serviceWorker.ready,
      });
    },
  };
}
