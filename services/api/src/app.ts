import { withChildScope } from '@ijime/agent-core';
import type { Kb } from '@ijime/kb-loader';
import {
  ApiHttpError,
  createServiceApp,
  type ServiceApp,
  type ServiceEnv,
} from '@ijime/service-kit';
import type { Hono } from 'hono';
import { cors } from 'hono/cors';

import { childAuth, type AuthEnv } from './auth.js';
import { registerChat, type ChatDeps } from './chat.js';
import { loadKb } from './kb.js';
import { registerCalendar, type CalendarRoutesDeps } from './routes/calendar.js';
import { registerAccounts, type AccountDeps } from './routes/accounts.js';
import { registerInvitations } from './routes/invitations.js';
import { registerGuardianWeekly } from './routes/guardian-weekly.js';
import { registerGuardianSettings } from './routes/guardian-settings.js';
import { registerSharedArtworks } from './routes/shared-artworks.js';
import { registerChildProfile } from './routes/child-profile.js';
import { registerChildGames } from './routes/child-games.js';
import { registerConsultations } from './routes/consultations.js';
import { registerCrisisAcknowledgements } from './routes/crisis-ack.js';
import { registerContextEvents } from './routes/context-events.js';
import {
  registerDeletion,
  registerGuardianDeletion,
  type DeletionDeps,
} from './routes/deletion.js';
import { registerFollowups } from './routes/followups.js';
import { registerHelpResources } from './routes/help-resources.js';
import { registerMemories } from './routes/memories.js';
import { registerAgentSummary } from './routes/agent-summary.js';
import { registerChildDevices } from './routes/child-devices.js';
import { registerNotifications, type NotificationRoutesDeps } from './routes/notifications.js';
import { registerIsland } from './routes/island.js';
import { registerPetRequests } from './routes/pet-requests.js';
import { registerProactive, type ProactiveRoutesDeps } from './routes/proactive.js';
import { registerRituals } from './routes/rituals.js';
import { registerSubmissions, type SubmissionDeps } from './routes/submissions.js';
import { registerVoice } from './routes/voice.js';
import { childOwner } from './routes/workflow-store.js';

export const SERVICE_NAME = 'api';

export type ApiDeps = {
  getKb: () => Promise<Kb>;
  allowedOrigins: string[];
  chat?: () => Promise<ChatDeps>;
  accounts?: () => Promise<AccountDeps>;
  guardian?: () => Promise<NotificationRoutesDeps>;
  guardianDeletion?: () => Promise<DeletionDeps>;
  calendar?: () => Promise<CalendarRoutesDeps>;
  submissions?: () => Promise<SubmissionDeps>;
  proactive?: () => Promise<ProactiveRoutesDeps>;
  voiceWsUrl?: string;
};

export function allowedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env['WEB_ORIGINS'] ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3100')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): ApiDeps {
  return { getKb: () => loadKb(), allowedOrigins: allowedOriginsFromEnv(env) };
}

export function createApp(deps: ApiDeps = defaultDeps()): ServiceApp {
  const app = createServiceApp({
    name: SERVICE_NAME,
    version: process.env['SERVICE_VERSION'] ?? '0.1.0',
    ready: () =>
      deps.getKb().then(
        () => true,
        () => false,
      ),
  });
  app.use('*', (_c, next) => withChildScope(next));
  app.use(
    '/v1/*',
    cors({
      origin: deps.allowedOrigins,
      allowHeaders: [
        'Authorization',
        'Content-Type',
        'X-Firebase-AppCheck',
        'Idempotency-Key',
        'X-Request-Id',
        'X-Dev-Child-Id',
        'X-Dev-Guardian-Id',
      ],
      exposeHeaders: ['X-Request-Id'],
      maxAge: 600,
    }),
  );
  registerHelpResources(app, deps.getKb);
  if (deps.accounts) {
    registerAccounts(app, deps.accounts);
    registerInvitations(app, deps.accounts);
  }
  if (deps.chat) {
    const chat = deps.chat;
    let ready: Promise<ChatDeps> | undefined;
    const get = () => (ready ??= chat());
    (app as unknown as Hono<AuthEnv & ServiceEnv>).use('/v1/child/*', async (c, next) => {
      if (
        ['/v1/child/help-resources', '/v1/child/pair', '/v1/child/data-deletion-requests'].includes(
          c.req.path,
        )
      )
        return next();
      if (c.req.method === 'DELETE' && /^\/v1\/child\/devices\/[a-f0-9]{64}$/.test(c.req.path))
        return next(); // The device route authenticates ownership, including paused accounts.
      const deps = await get();
      return childAuth(deps.auth)(c, async () => {
        const { data, child } = await childOwner(deps, c.get('child').childId);
        if (data['requiresGuardianConsent']) {
          const family = await deps.db.doc(`families/${child.familyId}`).get();
          if (family.get('status') !== 'active' || family.get('consentComplete') !== true)
            throw new ApiHttpError('CONSENT_REQUIRED', '保護者の同意が必要です');
        }
        if (
          (!deps.auth.allowDevHeader || data['requiresGuardianConsent']) &&
          !data['assentComplete'] &&
          c.req.path !== '/v1/child/assent'
        )
          throw new ApiHttpError('ASSENT_REQUIRED', '説明を確認してから始めてください');
        c.header('Cache-Control', 'no-store');
        await next();
      });
    });
    registerChildProfile(app, get, deps.getKb);
    registerChildGames(app, get, deps.getKb);
    registerMemories(app, get);
    registerAgentSummary(app, get);
    registerChildDevices(app, get);
    registerDeletion(app, get);
    registerFollowups(app, get);
    registerChat(app, get);
    registerConsultations(app, get);
    registerCrisisAcknowledgements(app, get);
    registerVoice(
      app,
      get,
      deps.voiceWsUrl ?? process.env['VOICE_WS_URL'] ?? 'ws://localhost:8083/v1/voice',
    );
  }
  if (deps.guardian) {
    const guardian = deps.guardian;
    let ready: Promise<NotificationRoutesDeps> | undefined;
    const get = () => (ready ??= guardian());
    registerNotifications(app, get);
    registerGuardianWeekly(app, get);
    registerGuardianSettings(app, get);
    registerContextEvents(app, get);
  }
  if (deps.guardianDeletion) registerGuardianDeletion(app, deps.guardianDeletion);
  if (deps.submissions) {
    const submissions = deps.submissions;
    let ready: Promise<SubmissionDeps> | undefined;
    const get = () => (ready ??= submissions());
    registerSubmissions(app, get);
    registerIsland(app, get);
    registerPetRequests(app, get);
    registerRituals(app, get);
    registerSharedArtworks(app, get);
  }
  if (deps.calendar) {
    const calendar = deps.calendar;
    let ready: Promise<CalendarRoutesDeps> | undefined;
    registerCalendar(app, () => (ready ??= calendar()));
  }
  if (deps.proactive) registerProactive(app, deps.proactive);
  return app;
}
