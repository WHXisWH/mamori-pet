import { describe, expect, it } from 'vitest';

import { CALENDAR_SCOPES, GoogleCalendarApi, InvalidGrantError } from './google-calendar.js';

const CLIENT = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://api.test/cb' };

function fakeFetch(handler: (url: string, init?: RequestInit) => [number, unknown]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const [status, body] = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  };
  return { fn, calls };
}

describe('GoogleCalendarApi', () => {
  it('builds an offline, read-only consent URL', () => {
    const u = new URL(new GoogleCalendarApi(CLIENT).authUrl('st'));
    expect(u.searchParams.get('scope')).toBe(CALENDAR_SCOPES.join(' '));
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('redirect_uri')).toBe(CLIENT.redirectUri);
    for (const s of CALENDAR_SCOPES) expect(s).toMatch(/\.readonly$/);
  });

  it('maps invalid_grant to InvalidGrantError', async () => {
    const { fn } = fakeFetch(() => [400, { error: 'invalid_grant' }]);
    await expect(new GoogleCalendarApi(CLIENT, fn).accessToken('rt')).rejects.toBeInstanceOf(
      InvalidGrantError,
    );
  });

  it('exchanges a code for a refresh token and granted scopes', async () => {
    const { fn, calls } = fakeFetch(() => [
      200,
      { refresh_token: 'rt', scope: CALENDAR_SCOPES.join(' ') },
    ]);
    const grant = await new GoogleCalendarApi(CLIENT, fn).exchangeCode('code1');
    expect(grant).toEqual({ refreshToken: 'rt', scopes: [...CALENDAR_SCOPES] });
    expect(String(calls[0]!.init!.body)).toContain('grant_type=authorization_code');
  });

  it('follows event pages with singleEvents', async () => {
    const { fn, calls } = fakeFetch((url) => {
      const token = new URL(url).searchParams.get('pageToken');
      return token
        ? [200, { items: [{ id: 'e2', start: {}, end: {} }] }]
        : [200, { items: [{ id: 'e1', start: {}, end: {} }], nextPageToken: 'p2' }];
    });
    const events = await new GoogleCalendarApi(CLIENT, fn).listEvents('at', 'a@b', {
      timeMin: '2026-01-01T00:00:00Z',
      timeMax: '2026-02-01T00:00:00Z',
    });
    expect(events.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(new URL(calls[0]!.url).searchParams.get('singleEvents')).toBe('true');
    expect(calls[0]!.url).toContain('/calendars/a%40b/events');
  });

  it('treats revoking an already-dead token as done', async () => {
    const { fn } = fakeFetch(() => [400, { error: 'invalid_token' }]);
    await expect(new GoogleCalendarApi(CLIENT, fn).revoke('rt')).resolves.toBeUndefined();
  });
});
