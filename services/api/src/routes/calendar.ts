import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { DocumentReference, Firestore } from '@google-cloud/firestore';
import type { CalendarConnectRes, CalendarSelectReq, CalendarsRes } from '@ijime/api-types';
import { calendar as calendarConfig } from '@ijime/config';
import { fieldAad, type TokenVault } from '@ijime/crypto';
import {
  ApiHttpError,
  CALENDAR_SCOPES,
  InvalidGrantError,
  type CalendarApi,
  type Logger,
  type ServiceApp,
  type ServiceEnv,
} from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { guardianAuth, type AuthOptions, type GuardianAuthEnv } from '../auth.js';
import { familyOfGuardian } from './notifications.js';

export type CalendarRoutesDeps = {
  db: Firestore;
  auth: AuthOptions;
  calendar: CalendarApi;
  vault: TokenVault;
  stateSecret: string;
  guardianWebOrigin: string;
  logger: Logger;
  now: () => Date;
};

type StatePayload = { g: string; f: string; exp: number; n: string };

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signState(secret: string, p: Omit<StatePayload, 'n'>): string {
  const body = b64(JSON.stringify({ ...p, n: randomBytes(8).toString('hex') }));
  return `${body}.${b64(createHmac('sha256', secret).update(body).digest())}`;
}

export function verifyState(secret: string, state: string, now: Date): StatePayload | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    if (typeof p.g !== 'string' || typeof p.f !== 'string' || !(p.exp > now.getTime())) return null;
    return p;
  } catch {
    return null;
  }
}

export const connectionPath = (familyId: string, guardianId: string) =>
  `families/${familyId}/calendarConnections/${guardianId}`;

const tokenAad = (familyId: string, guardianId: string) =>
  fieldAad(connectionPath(familyId, guardianId), 'refreshTokenEnc');

const selectSchema = z.object({
  calendarIds: z.array(z.string().min(1).max(256)).min(1).max(20),
});

type StoredConnection = {
  calendarIds: string[];
  refreshTokenEnc: Uint8Array;
  status: 'active' | 'revoked' | 'error';
};

export function registerCalendar(
  app: ServiceApp,
  getDeps: () => Promise<CalendarRoutesDeps>,
): void {
  const r = (app as unknown as Hono<GuardianAuthEnv & ServiceEnv>).basePath('/v1/calendar');
  r.use('*', async (c, next) => {
    if (c.req.path === '/v1/calendar/callback') return next();
    const deps = await getDeps();
    return guardianAuth(deps.auth, (g) => familyOfGuardian(deps.db, g))(c, next);
  });

  r.post('/connect', async (c) => {
    const deps = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const exp = deps.now().getTime() + calendarConfig.oauthStateMinutes * 60_000;
    const state = signState(deps.stateSecret, { g: guardianId, f: familyId, exp });
    const body: CalendarConnectRes = { authUrl: deps.calendar.authUrl(state) };
    return c.json(body);
  });

  r.get('/callback', async (c) => {
    const deps = await getDeps();
    const back = (result: string) =>
      c.redirect(`${deps.guardianWebOrigin}/context?calendar=${result}`, 302);
    const state = verifyState(deps.stateSecret, c.req.query('state') ?? '', deps.now());
    const code = c.req.query('code');
    if (!state || !code || c.req.query('error')) return back('error');
    if ((await familyOfGuardian(deps.db, state.g)) !== state.f) return back('error');

    let grant;
    try {
      grant = await deps.calendar.exchangeCode(code);
    } catch (err) {
      deps.logger.warn('calendar.exchange_failed', {
        reason: err instanceof Error ? err.name : 'unknown',
      });
      return back('error');
    }
    if (!CALENDAR_SCOPES.every((s) => grant.scopes.includes(s))) {
      await deps.calendar.revoke(grant.refreshToken).catch(() => undefined);
      return back('scope_denied');
    }
    const ref = deps.db.doc(connectionPath(state.f, state.g));
    const prev = (await ref.get()).data() as StoredConnection | undefined;
    await ref.set({
      calendarIds: prev?.calendarIds?.length ? prev.calendarIds : ['primary'],
      refreshTokenEnc: await deps.vault.seal(grant.refreshToken, tokenAad(state.f, state.g)),
      scopes: grant.scopes,
      status: 'active',
    });
    deps.logger.info('calendar.connected', { familyId: state.f });
    return back('connected');
  });

  const openConnection = async (deps: CalendarRoutesDeps, familyId: string, guardianId: string) => {
    const ref = deps.db.doc(connectionPath(familyId, guardianId));
    const conn = (await ref.get()).data() as StoredConnection | undefined;
    if (!conn || conn.status === 'revoked')
      throw new ApiHttpError('NOT_FOUND', 'カレンダーが連携されていません');
    const refreshToken = await deps.vault.open(
      Buffer.from(conn.refreshTokenEnc),
      tokenAad(familyId, guardianId),
    );
    return { ref, conn, refreshToken };
  };

  const listCalendars = async (
    deps: CalendarRoutesDeps,
    ref: DocumentReference,
    refreshToken: string,
  ) => {
    try {
      return await deps.calendar.listCalendars(await deps.calendar.accessToken(refreshToken));
    } catch (err) {
      if (!(err instanceof InvalidGrantError)) throw err;
      await ref.update({ status: 'revoked' });
      throw new ApiHttpError(
        'NOT_FOUND',
        'カレンダーの連携が切れています。もう一度連携してください',
      );
    }
  };

  r.get('/calendars', async (c) => {
    const deps = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const { ref, conn, refreshToken } = await openConnection(deps, familyId, guardianId);
    const items = await listCalendars(deps, ref, refreshToken);
    const selected = new Set(conn.calendarIds);
    const body: CalendarsRes = {
      items: items.map((cal) => ({
        calendarId: cal.id,
        name: cal.summary,
        selected: selected.has(cal.id) || (cal.primary === true && selected.has('primary')),
      })),
    };
    return c.json(body);
  });

  r.put('/connection', async (c) => {
    const deps = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const parsed = selectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', 'カレンダーを選んでください');
    const req: CalendarSelectReq = parsed.data;
    const { ref, refreshToken } = await openConnection(deps, familyId, guardianId);
    const available = new Set(
      (await listCalendars(deps, ref, refreshToken)).flatMap((cal) =>
        cal.primary ? [cal.id, 'primary'] : [cal.id],
      ),
    );
    if (!req.calendarIds.every((id) => available.has(id)))
      throw new ApiHttpError('INVALID_ARGUMENT', '選べないカレンダーが含まれています');
    await ref.update({ calendarIds: [...new Set(req.calendarIds)], status: 'active' });
    return c.body(null, 204);
  });

  r.delete('/connection', async (c) => {
    const deps = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const ref = deps.db.doc(connectionPath(familyId, guardianId));
    const conn = (await ref.get()).data() as StoredConnection | undefined;
    if (conn) {
      try {
        const token = await deps.vault.open(
          Buffer.from(conn.refreshTokenEnc),
          tokenAad(familyId, guardianId),
        );
        await deps.calendar.revoke(token);
      } catch (err) {
        deps.logger.warn('calendar.revoke_failed', {
          familyId,
          reason: err instanceof Error ? err.name : 'unknown',
        });
      }
      const events = await deps.db
        .collection(`families/${familyId}/contextEvents`)
        .where('createdBy', '==', guardianId)
        .where('source', '==', 'calendar')
        .get();
      const writer = deps.db.bulkWriter();
      for (const d of events.docs) void writer.delete(d.ref);
      void writer.delete(ref);
      await writer.close();
    }
    return c.body(null, 204);
  });
}
