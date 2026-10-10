import type {
  CrisisAckRes,
  CrisisPayload,
  HelpResourcesRes,
  IslandPutReq,
  IslandPutRes,
  IslandStateRes,
  LocalDate,
  PetRequestDeclineRes,
  PetRequestsRes,
  RitualKind,
  RitualRes,
} from '@ijime/api-types';
import { childIdToken } from './auth';
import { childAppCheckToken } from './app-check';

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8080';

export const DEV_CHILD_HEADER = 'X-Dev-Child-Id';

export class ChildApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ChildApiError) {
    if (error.code === 'MODEL_UNAVAILABLE')
      return 'いまは AI に つながりません。あとで もういちど ためしてね。';
    if (error.code === 'DATA_SOURCE_DISABLED')
      return 'この きのうは おやすみ中です。せっていで かえられます。';
    if (error.code === 'UNAUTHENTICATED')
      return 'つなぎなおしが ひつようです。おとなと いっしょに かくにんしてね。';
    if (error.code === 'NOT_FOUND') return 'みつかりませんでした。もういちど ひらいてね。';
    if (error.code === 'RATE_LIMITED')
      return 'ちょっと 休けいしよう。あとで もういちど ためしてね。';
  }
  return 'うまく つながりませんでした。まだ できていません。もういちど ためしてね。';
}

export async function childRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await childFetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw new ChildApiError(body?.error?.code ?? 'REQUEST_FAILED', res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

// Streaming chat uses the same auth path as JSON requests but cannot use childRequest because
// its body must stay readable. Keep the one-refresh rule in one place for both paths.
export async function childFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(await childAuthHeaders())) headers.set(key, value);
  if (init.body && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  let res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, cache: 'no-store' });
  if (res.status === 401 && (headers.has('Authorization') || headers.has('X-Firebase-AppCheck'))) {
    const refreshed = await childIdToken(true);
    const refreshedAppCheck = await childAppCheckToken(true);
    if (refreshed) headers.set('Authorization', `Bearer ${refreshed}`);
    if (refreshedAppCheck) headers.set('X-Firebase-AppCheck', refreshedAppCheck);
    if (refreshed || refreshedAppCheck)
      res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, cache: 'no-store' });
  }
  return res;
}

// 子どもがセーフモード画面で「いまは安全」と確認する。家庭内の危害の危機にのみ有効（2026-10-10 決定）
export async function acknowledgeCrisis(): Promise<CrisisAckRes> {
  const res = await childRequest<CrisisAckRes>('/v1/child/crisis-acknowledgements', {
    method: 'POST',
    body: '{}',
  });
  try {
    sessionStorage.removeItem('mamori-crisis');
  } catch {
    // nothing to clear
  }
  return res;
}

export function saveCrisis(payload: CrisisPayload): void {
  try {
    sessionStorage.setItem('mamori-crisis', JSON.stringify(payload));
  } catch {
    // The safety page has an offline fallback if session storage is unavailable.
  }
}

export function devHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  if (process.env.NEXT_PUBLIC_LOCAL_DEMO !== '1' && process.env.NODE_ENV !== 'development')
    return {};
  try {
    const raw = window.localStorage.getItem('mamori-child');
    const childId = raw ? (JSON.parse(raw) as { state?: { childId?: string } }).state?.childId : '';
    return childId ? { [DEV_CHILD_HEADER]: childId } : {};
  } catch {
    return {};
  }
}

export async function childAuthHeaders(forceRefresh = false): Promise<Record<string, string>> {
  const token = await childIdToken(forceRefresh);
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : devHeaders();
  const appCheck = await childAppCheckToken(forceRefresh);
  if (appCheck) headers['X-Firebase-AppCheck'] = appCheck;
  return headers;
}

export async function fetchHelpResources(signal?: AbortSignal): Promise<HelpResourcesRes> {
  const init: RequestInit = { cache: 'no-store' };
  if (signal) init.signal = signal;
  const res = await fetch(`${API_BASE_URL}/v1/child/help-resources`, init);
  if (!res.ok) throw new Error(`help-resources ${res.status}`);
  return (await res.json()) as HelpResourcesRes;
}

export function fetchIsland(): Promise<IslandStateRes> {
  return childRequest<IslandStateRes>('/v1/child/island');
}

export function saveIsland(body: IslandPutReq): Promise<IslandPutRes> {
  return childRequest<IslandPutRes>('/v1/child/island', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function recordRitual(kind: RitualKind, localDate: LocalDate): Promise<RitualRes> {
  return childRequest<RitualRes>('/v1/child/rituals', {
    method: 'POST',
    body: JSON.stringify({ kind, localDate }),
  });
}

export function fetchPetRequests(): Promise<PetRequestsRes> {
  return childRequest<PetRequestsRes>('/v1/child/pet-requests');
}

export function declinePetRequest(requestId: string): Promise<PetRequestDeclineRes> {
  return childRequest<PetRequestDeclineRes>(
    `/v1/child/pet-requests/${encodeURIComponent(requestId)}/decline`,
    { method: 'POST' },
  );
}
