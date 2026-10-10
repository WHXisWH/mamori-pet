import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signOut } from 'firebase/auth';

export function childFirebaseApp() {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (typeof window === 'undefined' || !apiKey || !projectId) return undefined;
  const name = 'mamori-child';
  return getApps().some((app) => app.name === name)
    ? getApp(name)
    : initializeApp(
        {
          apiKey,
          projectId,
          ...(process.env.NEXT_PUBLIC_FIREBASE_APP_ID
            ? { appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID }
            : {}),
          ...(process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
            ? { messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID }
            : {}),
          ...(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
            ? { authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN }
            : {}),
        },
        name,
      );
}

function childAuth() {
  const app = childFirebaseApp();
  return app ? getAuth(app) : undefined;
}

export async function signInPairedChild(customToken: string, childId: string) {
  if (customToken.startsWith('local-demo:')) {
    if (
      (process.env.NEXT_PUBLIC_LOCAL_DEMO !== '1' && process.env.NODE_ENV !== 'development') ||
      customToken !== `local-demo:${childId}`
    )
      throw new Error('local_identity_not_allowed');
    await (await import('./push')).disableChildPush();
    return;
  }
  const auth = childAuth();
  if (!auth) throw new Error('identity_not_configured');
  // Revoke the old device using the old identity before replacing its auth session.
  await (await import('./push')).disableChildPush();
  await signInWithCustomToken(auth, customToken);
}

export async function signOutPairedChild(): Promise<void> {
  await (await import('./push')).disableChildPush();
  const auth = childAuth();
  if (auth) await signOut(auth);
}

export async function childIdToken(forceRefresh = false): Promise<string | undefined> {
  if (process.env.NEXT_PUBLIC_LOCAL_DEMO === '1' || process.env.NODE_ENV === 'development')
    return undefined;
  const auth = childAuth();
  if (!auth) return undefined;
  await auth.authStateReady();
  return auth.currentUser?.getIdToken(forceRefresh);
}
