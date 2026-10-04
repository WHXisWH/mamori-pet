export type GoogleRequest = {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string>;
};

export class GoogleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseText: string,
  ) {
    super(`google api responded ${status}`);
    this.name = 'GoogleHttpError';
  }
}

export interface GoogleHttp {
  request<T>(req: GoogleRequest): Promise<T>;
}

function withQuery(url: string, query?: Record<string, string>): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

// アプリケーションのデフォルト認証情報（Cloud Run のサービスアカウント）で Google REST API を呼び出す
export class AdcGoogleHttp implements GoogleHttp {
  private client: Promise<{
    request<T>(o: { url: string; method: string; data?: unknown }): Promise<{ data: T }>;
  }>;

  constructor(scopes: string[] = ['https://www.googleapis.com/auth/cloud-platform']) {
    this.client = import('google-auth-library').then(({ GoogleAuth }) =>
      new GoogleAuth({ scopes }).getClient(),
    ) as never;
  }

  async request<T>(req: GoogleRequest): Promise<T> {
    const client = await this.client;
    try {
      const res = await client.request<T>({
        url: withQuery(req.url, req.query),
        method: req.method,
        ...(req.body === undefined ? {} : { data: req.body }),
      });
      return res.data;
    } catch (err) {
      const e = err as { response?: { status?: number; data?: unknown } };
      if (e.response?.status)
        throw new GoogleHttpError(e.response.status, JSON.stringify(e.response.data ?? ''));
      throw err;
    }
  }
}

// 別の Cloud Run サービスの内部エンドポイントを呼び出す。このサービスのアカウントで、呼び出し先サービスの URL を audience とする ID トークンを取得する（ライブラリがキャッシュする）
export function cloudRunIdToken(audience: string): () => Promise<string | undefined> {
  const client = import('google-auth-library').then(({ GoogleAuth }) =>
    new GoogleAuth().getIdTokenClient(audience),
  );
  return async () => {
    const headers = await (await client).getRequestHeaders();
    return headers.get('authorization')?.replace(/^Bearer /i, '') ?? undefined;
  };
}

// エミュレーターなど認証が不要なエンドポイント
export class PlainHttp implements GoogleHttp {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async request<T>(req: GoogleRequest): Promise<T> {
    const res = await this.fetchImpl(withQuery(req.url, req.query), {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new GoogleHttpError(res.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }
}
