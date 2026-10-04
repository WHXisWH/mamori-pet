import type {
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
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(await childAuthHeaders())) headers.set(key, value);
  if (init.body && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers, cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    throw new ChildApiError(body?.error?.code ?? 'REQUEST_FAILED', res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
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

export async function childAuthHeaders(): Promise<Record<string, string>> {
  const token = await childIdToken();
  return token ? { Authorization: `Bearer ${token}` } : devHeaders();
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
