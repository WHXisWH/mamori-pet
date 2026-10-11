export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8080';
// 子ども用アプリの URL。ペアリング画面で保護者に見せる（docs/05-frontend.md ペアリング）
export const CHILD_APP_URL = process.env.NEXT_PUBLIC_CHILD_APP_URL ?? 'http://localhost:3100';
export const LOCAL_TEST =
  process.env.NEXT_PUBLIC_LOCAL_DEMO === '1' || process.env.NODE_ENV === 'development';

export class GuardianApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GuardianApiError';
  }
}

export async function guardianRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!LOCAL_TEST && !headers.has('Authorization')) {
    const token = await guardianIdToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  if (LOCAL_TEST && !headers.has('Authorization') && !headers.has('X-Dev-Guardian-Id')) {
    let id = 'g_dev';
    try {
      if (typeof window !== 'undefined') id = localStorage.getItem('mamori-guardian-id') || id;
    } catch {
      /* Storage may be unavailable in private browsing. */
    }
    headers.set('X-Dev-Guardian-Id', id);
  }
  if (init.body) headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: unknown; message?: unknown };
    } | null;
    throw new GuardianApiError(
      res.status,
      typeof body?.error?.code === 'string' ? body.error.code : 'REQUEST_FAILED',
      typeof body?.error?.message === 'string'
        ? body.error.message
        : '読み込めませんでした。もう一度お試しください。',
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
import { guardianIdToken } from './auth';
