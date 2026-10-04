import { getApp, getApps, initializeApp } from 'firebase/app';
import { EmailAuthProvider, getAuth, reauthenticateWithCredential } from 'firebase/auth';

export function guardianAuth() {
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (typeof window === 'undefined' || !apiKey || !projectId) return undefined;
  const name = 'mamori-guardian';
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

export async function guardianIdToken(forceRefresh = false): Promise<string | undefined> {
  const auth = guardianAuth();
  if (!auth) return undefined;
  await auth.authStateReady();
  return auth.currentUser?.getIdToken(forceRefresh);
}

// 同意に署名する前にアカウント本人であることを再確認する。パスワードを再入力してログインし、新しい auth_time を持つトークンを取得する。
export async function reauthenticateGuardian(password: string): Promise<void> {
  const auth = guardianAuth();
  if (!auth) throw new Error('not_configured');
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user?.email) throw new Error('not_signed_in');
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  await user.getIdToken(true);
}
