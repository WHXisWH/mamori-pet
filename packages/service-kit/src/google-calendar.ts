// Google カレンダーの OAuth と読み取り専用 API（api の認可フローと calendar-sync で共用）
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.readonly',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/calendar/v3';

export type CalendarEventTime = { date?: string; dateTime?: string };
export type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  start: CalendarEventTime;
  end: CalendarEventTime;
};
export type CalendarListItem = { id: string; summary: string; primary?: boolean };
export type TokenGrant = { refreshToken: string; scopes: string[] };

// リフレッシュトークンが無効または取り消し済み。接続を revoked にすること
export class InvalidGrantError extends Error {
  constructor() {
    super('invalid_grant');
    this.name = 'InvalidGrantError';
  }
}

export class CalendarApiError extends Error {
  constructor(readonly status: number) {
    super(`calendar api responded ${status}`);
    this.name = 'CalendarApiError';
  }
}

export interface CalendarApi {
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<TokenGrant>;
  accessToken(refreshToken: string): Promise<string>;
  listCalendars(accessToken: string): Promise<CalendarListItem[]>;
  listEvents(
    accessToken: string,
    calendarId: string,
    window: { timeMin: string; timeMax: string },
  ): Promise<CalendarEvent[]>;
  revoke(token: string): Promise<void>;
}

export type OAuthClientConfig = { clientId: string; clientSecret: string; redirectUri: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class GoogleCalendarApi implements CalendarApi {
  constructor(
    private readonly client: OAuthClientConfig,
    private readonly fetchFn: FetchLike = fetch,
  ) {}

  authUrl(state: string): string {
    const u = new URL(AUTH_URL);
    u.searchParams.set('client_id', this.client.clientId);
    u.searchParams.set('redirect_uri', this.client.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', CALENDAR_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    return u.toString();
  }

  async exchangeCode(code: string): Promise<TokenGrant> {
    const body = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.client.redirectUri,
    });
    if (typeof body['refresh_token'] !== 'string') throw new CalendarApiError(400);
    const scope = typeof body['scope'] === 'string' ? body['scope'] : '';
    return { refreshToken: body['refresh_token'], scopes: scope.split(' ').filter(Boolean) };
  }

  async accessToken(refreshToken: string): Promise<string> {
    const body = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    if (typeof body['access_token'] !== 'string') throw new CalendarApiError(502);
    return body['access_token'];
  }

  async listCalendars(accessToken: string): Promise<CalendarListItem[]> {
    const items: CalendarListItem[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ minAccessRole: 'reader' });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await this.get<{ items?: CalendarListItem[]; nextPageToken?: string }>(
        `${API}/users/me/calendarList?${q}`,
        accessToken,
      );
      for (const c of page.items ?? [])
        items.push({ id: c.id, summary: c.summary, ...(c.primary ? { primary: true } : {}) });
      pageToken = page.nextPageToken;
    } while (pageToken);
    return items;
  }

  async listEvents(
    accessToken: string,
    calendarId: string,
    window: { timeMin: string; timeMax: string },
  ): Promise<CalendarEvent[]> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        singleEvents: 'true',
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        maxResults: '250',
        fields: 'items(id,status,summary,start,end),nextPageToken',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const page = await this.get<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        `${API}/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
        accessToken,
      );
      events.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return events;
  }

  async revoke(token: string): Promise<void> {
    const res = await this.fetchFn(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    // すでに無効なトークンの取り消しは 400 が返るが、取り消し済みとして扱う
    if (!res.ok && res.status !== 400) throw new CalendarApiError(res.status);
  }

  private async token(params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
        ...params,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (body['error'] === 'invalid_grant') throw new InvalidGrantError();
      throw new CalendarApiError(res.status);
    }
    return body;
  }

  private async get<T>(url: string, accessToken: string): Promise<T> {
    const res = await this.fetchFn(url, { headers: { authorization: `Bearer ${accessToken}` } });
    if (res.status === 401) throw new InvalidGrantError();
    if (!res.ok) throw new CalendarApiError(res.status);
    return (await res.json()) as T;
  }
}

type MemoryAccount = {
  calendars: CalendarListItem[];
  events: Record<string, CalendarEvent[]>;
  fail?: Error;
};

// テスト用：リフレッシュトークンでアカウントを区別する
export class MemoryCalendarApi implements CalendarApi {
  readonly accounts = new Map<string, MemoryAccount>();
  readonly revoked: string[] = [];
  readonly codes = new Map<string, TokenGrant>();
  readonly listCalls: { calendarId: string; timeMin: string; timeMax: string }[] = [];

  authUrl(state: string): string {
    return `${AUTH_URL}?state=${encodeURIComponent(state)}&scope=${encodeURIComponent(CALENDAR_SCOPES.join(' '))}`;
  }

  async exchangeCode(code: string): Promise<TokenGrant> {
    const grant = this.codes.get(code);
    if (!grant) throw new InvalidGrantError();
    return grant;
  }

  async accessToken(refreshToken: string): Promise<string> {
    const acct = this.accounts.get(refreshToken);
    if (!acct || this.revoked.includes(refreshToken)) throw new InvalidGrantError();
    if (acct.fail) throw acct.fail;
    return `at:${refreshToken}`;
  }

  async listCalendars(accessToken: string): Promise<CalendarListItem[]> {
    return this.account(accessToken).calendars;
  }

  async listEvents(
    accessToken: string,
    calendarId: string,
    window: { timeMin: string; timeMax: string },
  ): Promise<CalendarEvent[]> {
    this.listCalls.push({ calendarId, ...window });
    return this.account(accessToken).events[calendarId] ?? [];
  }

  async revoke(token: string): Promise<void> {
    this.revoked.push(token);
  }

  private account(accessToken: string): MemoryAccount {
    const acct = this.accounts.get(accessToken.replace(/^at:/, ''));
    if (!acct) throw new InvalidGrantError();
    return acct;
  }
}
