import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';

function childAuth() {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (typeof window === 'undefined' || !apiKey || !projectId) return undefined;
  const name = 'mamori-child';
  const app = getApps().some((app) => app.name === name)
    ? getApp(name)
    : initializeApp(
        {
          apiKey,
          projectId,
          ...(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN
            ? { authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN }
            : {}),
        },
        name,
      );
  return getAuth(app);
}

export async function signInPairedChild(customToken: string, childId: string) {
  if (customToken.startsWith('local-demo:')) {
    if (
      (process.env.NEXT_PUBLIC_LOCAL_DEMO !== '1' && process.env.NODE_ENV !== 'development') ||
      customToken !== `local-demo:${childId}`
    )
      throw new Error('local_identity_not_allowed');
    return;
  }
  const auth = childAuth();
  if (!auth) throw new Error('identity_not_configured');
  await signInWithCustomToken(auth, customToken);
}

export async function childIdToken(): Promise<string | undefined> {
  if (process.env.NEXT_PUBLIC_LOCAL_DEMO === '1' || process.env.NODE_ENV === 'development')
    return undefined;
  const auth = childAuth();
  if (!auth) return undefined;
  await auth.authStateReady();
  return auth.currentUser?.getIdToken();
}
