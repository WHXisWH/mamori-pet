import { childFirebaseApp } from './auth';
import {
  getToken,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check';

let appCheck: AppCheck | undefined;

export async function childAppCheckToken(forceRefresh = false): Promise<string | undefined> {
  if (typeof window === 'undefined') return undefined;
  const siteKey = process.env.NEXT_PUBLIC_FIREBASE_APP_CHECK_SITE_KEY;
  if (!siteKey) return undefined;
  try {
    if (!appCheck) {
      const app = childFirebaseApp();
      if (!app) return undefined;
      appCheck = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
    }
    const result = await getToken(appCheck, forceRefresh);
    return result.token || undefined;
  } catch {
    // The API returns a regular auth error when production App Check is unavailable. Do not
    // expose provider details to a child or turn them into a retry storm.
    return undefined;
  }
}
