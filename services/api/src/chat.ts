import type { Firestore } from '@google-cloud/firestore';
import type { ChildDirectory, FirestoreSessionService } from '@ijime/agent-core';
import { PET_APP_NAME } from '@ijime/agent-core';
import type {
  GradeBand,
  HelpResource,
  MessagesRes,
  SendMessageReq,
  SessionsRes,
  StartSessionRes,
} from '@ijime/api-types';
import { agent as agentConfig, limits, slo } from '@ijime/config';
import {
  crisisEventDoc,
  crisisResponse,
  type CrisisDetector,
  type SafeModeCopy,
} from '@ijime/crisis-detector';
import { ApiHttpError, type Logger, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import { checkWithinBudget } from './model-budget.js';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { childAuth, type AuthEnv, type AuthOptions } from './auth.js';
import type { PetAgentClient } from './pet-agent-client.js';
import { persistSubmission } from './submission-store.js';

export type ChatDeps = {
  db: Firestore;
  sessions: FirestoreSessionService;
  directory: ChildDirectory;
  detector: CrisisDetector;
  petAgent: PetAgentClient;
  openings: Record<GradeBand, string[]>;
  safeModeCopy: SafeModeCopy;
  hotlines: HelpResource[];
  coaching: Record<GradeBand, string[]>;
  auth: AuthOptions;
  logger: Logger;
  publish: (topic: string, payload: Record<string, unknown>) => Promise<void>;
};

const sendMessageSchema = z.object({
  text: z.string().min(limits.messageText.min).max(limits.messageText.max),
  inputMode: z.enum(['typed', 'quick_reply']),
  typing: z
    .object({
      keyCount: z.number().int().nonnegative(),
      deleteCount: z.number().int().nonnegative(),
      composeMs: z.number().int().nonnegative(),
      longPauseCount: z.number().int().nonnegative(),
    })
    .optional(),
  clientSentAt: z.string(),
});

export function registerChat(app: ServiceApp, getDeps: () => Promise<ChatDeps>): void {
  const chat = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child/chat');
  chat.use('*', async (c, next) => childAuth((await getDeps()).auth)(c, next));
  chat.use('*', async (c, next) => {
    await next();
    if (c.res.headers.get('content-type') === 'text/event-stream')
      c.header('Content-Type', 'text/event-stream; charset=utf-8');
  });

  chat.post('/sessions', async (c) => {
    const deps = await getDeps();
    const { childId } = c.get('child');
    const child = await deps.directory.lookup(childId);
    if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
    const session = await deps.sessions.createSession({
      appName: PET_APP_NAME,
      userId: childId,
      state: { channel: 'text' },
    });
    const openings = deps.openings[child.gradeBand];
    const body: StartSessionRes = {
      sessionId: session.id,
      openingMessage: openings[Math.floor(Math.random() * openings.length)]!,
    };
    return c.json(body, 201);
  });

  chat.get('/sessions', async (c) => {
    const deps = await getDeps();
    const { childId } = c.get('child');
    const list = await deps.sessions.listSessions({
      appName: PET_APP_NAME,
      userId: childId,
      limit: limits.pageSize.default,
    });
    const body: SessionsRes = {
      items: list.sessions.map((s) => ({
        sessionId: s.id,
        channel: 'text',
        startedAt: new Date(s.lastUpdateTime).toISOString(),
        preview: '',
      })),
    };
    return c.json(body);
  });

  chat.get('/sessions/:sessionId/messages', async (c) => {
    const deps = await getDeps();
    const { childId } = c.get('child');
    const sessionId = c.req.param('sessionId');
    const session = await deps.sessions.getSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId,
      config: { numRecentEvents: 0 },
    });
    if (!session) throw new ApiHttpError('NOT_FOUND', 'unknown session');
    const msgs = await deps.sessions.readMessages(childId, sessionId, limits.pageSize.max);
    const body: MessagesRes = {
      items: msgs.map((m) => ({
        messageId: m.messageId,
        role: m.role === 'pet' ? 'pet' : 'child',
        text: m.text,
        createdAt: m.createdAt.toISOString(),
      })),
    };
    return c.json(body);
  });

  chat.delete('/sessions/:sessionId', async (c) => {
    const deps = await getDeps();
    const { childId } = c.get('child');
    await deps.sessions.deleteSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId: c.req.param('sessionId'),
    });
    return c.body(null, 204);
  });

  chat.post('/sessions/:sessionId/messages', async (c) => {
    const requestStarted = performance.now();
    const deps = await getDeps();
    const { childId } = c.get('child');
    const sessionId = c.req.param('sessionId');
    const parsed = sendMessageSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ApiHttpError('INVALID_ARGUMENT', 'メッセージの形式が正しくありません');
    const req: SendMessageReq = {
      text: parsed.data.text,
      inputMode: parsed.data.inputMode,
      clientSentAt: parsed.data.clientSentAt,
      ...(parsed.data.typing ? { typing: parsed.data.typing } : {}),
    };
    const child = await deps.directory.lookup(childId);
    if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
    const session = await deps.sessions.getSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId,
      config: { numRecentEvents: 3 },
    });
    if (!session) throw new ApiHttpError('NOT_FOUND', 'unknown session');
    const log = deps.logger;
    const base = `families/${child.familyId}/children/${childId}`;
    const [activeCrises, storedSession] = await Promise.all([
      deps.db.collection(`${base}/crisisEvents`).where('status', '==', 'open').limit(1).get(),
      deps.db.doc(`${base}/sessions/${sessionId}`).get(),
    ]);
    if (!activeCrises.empty || storedSession.get('safeMode') === true) {
      const active = activeCrises.docs[0];
      const { message, resources } = crisisResponse({
        familyHarmSuspected: active?.get('familyHarmSuspected') !== false,
        gradeBand: child.gradeBand,
        copy: deps.safeModeCopy,
        hotlines: deps.hotlines,
      });
      return streamSSE(c, async (s) => {
        await s.writeSSE({
          event: 'meta',
          data: JSON.stringify({ messageId: '', safeMode: true }),
        });
        await s.writeSSE({
          event: 'crisis',
          data: JSON.stringify({ crisisId: active?.id ?? sessionId, message, resources }),
        });
      });
    }

    const priorTurns = session.events
      .filter((e) => e.content?.role === 'user')
      .map((e) => (e.content?.parts ?? []).map((p) => p.text ?? '').join(''))
      .filter(Boolean);
    const check = await checkWithinBudget(deps, child, base, {
      text: req.text,
      gradeBand: child.gradeBand,
      priorTurns,
    });
    log.info('crisis.check', {
      pseudoId: childId,
      sessionId,
      hit: check.hit,
      method: check.method,
      category: check.category,
      latencyMs: Math.round(check.latencyMs),
    });

    // Crisis handling stays available even after the ordinary conversation budget is exhausted.
    if (!check.hit) {
      const date = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
      const usage = deps.db.doc(`${base}/chatUsage/${date}`);
      await deps.db.runTransaction(async (tx) => {
        const owner = await tx.get(deps.db.doc(base));
        const snapshot = await tx.get(usage);
        if (owner.get('status') !== 'active')
          throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
        const turns = Number(snapshot.get('turns') ?? 0);
        if (turns >= agentConfig.dailyTurnLimit)
          throw new ApiHttpError(
            'RATE_LIMITED',
            '今日は少し休けいしよう。困ったときの連絡先はいつでも開けるよ。',
          );
        tx.set(usage, { turns: turns + 1, expireAt: new Date(Date.now() + 2 * 86_400_000) });
      });
    }

    const { messageId } = await deps.sessions.writeChildMessage(childId, sessionId, {
      text: req.text,
      inputMode: req.inputMode,
      ...(req.typing ? { typing: req.typing } : {}),
      crisisCheck: {
        hit: check.hit,
        method: check.method,
        score: check.confidence,
        checkedAt: new Date(),
      },
    });
    await deps.publish('message.created', {
      familyId: child.familyId,
      childId,
      sessionId,
      messageId,
      channel: 'text',
    });

    return streamSSE(c, async (s) => {
      await s.writeSSE({ event: 'meta', data: JSON.stringify({ messageId, safeMode: check.hit }) });
      if (check.hit) {
        const crisisRef = deps.db.collection(`${base}/crisisEvents`).doc();
        await persistSubmission(
          deps.db,
          base,
          crisisRef,
          crisisEventDoc({
            triggerType: 'text',
            sourceRef: `families/${child.familyId}/children/${childId}/sessions/${sessionId}/messages/${messageId}`,
            check,
            now: new Date(),
          }),
        );
        await deps.sessions.markSafeMode(childId, sessionId);
        await deps.publish('crisis.detected', {
          childId,
          crisisId: crisisRef.id,
          familyHarmSuspected: check.familyHarmSuspected,
        });
        log.warn('crisis.detected', {
          pseudoId: childId,
          crisisId: crisisRef.id,
          category: check.category,
          familyHarmSuspected: check.familyHarmSuspected,
        });
        const { message, resources } = crisisResponse({
          familyHarmSuspected: check.familyHarmSuspected,
          gradeBand: child.gradeBand,
          copy: deps.safeModeCopy,
          hotlines: deps.hotlines,
        });
        await s.writeSSE({
          event: 'crisis',
          data: JSON.stringify({ crisisId: crisisRef.id, message, resources }),
        });
        return;
      }
      try {
        let firstVisibleTextMs: number | null = null;
        for await (const chunk of deps.petAgent.turn(
          { childId, sessionId, messageId },
          c.req.raw.signal,
        )) {
          if (chunk.type === 'crisis') {
            // ペットが escalate_crisis を呼んだ（crisisEvents は pet-agent が書き込み済み）：通知の経路は事前検知でヒットしたときと同じ
            const record = await deps.db.doc(`${base}/crisisEvents/${chunk.crisisId}`).get();
            const familyHarmSuspected = record.get('familyHarmSuspected') !== false;
            await deps.sessions.markSafeMode(childId, sessionId);
            await deps.publish('crisis.detected', {
              childId,
              crisisId: chunk.crisisId,
              familyHarmSuspected,
            });
            log.warn('crisis.detected', {
              pseudoId: childId,
              crisisId: chunk.crisisId,
              source: 'agent_tool',
              familyHarmSuspected,
            });
            const { message, resources } = crisisResponse({
              familyHarmSuspected,
              gradeBand: child.gradeBand,
              copy: deps.safeModeCopy,
              hotlines: deps.hotlines,
            });
            await s.writeSSE({
              event: 'crisis',
              data: JSON.stringify({ crisisId: chunk.crisisId, message, resources }),
            });
            return;
          }
          if (chunk.type === 'delta') {
            if (chunk.text) firstVisibleTextMs ??= Math.round(performance.now() - requestStarted);
            await s.writeSSE({ event: 'delta', data: JSON.stringify({ text: chunk.text }) });
          } else if (chunk.type === 'action')
            await s.writeSSE({ event: 'action', data: JSON.stringify(chunk.action) });
          else {
            log.info('chat.turn', {
              pseudoId: childId,
              sessionId,
              latencyMs: Math.round(performance.now() - requestStarted),
              safetyLatencyMs: Math.round(check.latencyMs),
              firstVisibleTextMs,
              firstTokenTargetMs: slo.firstTokenTargetMs,
              withinFirstTokenTarget:
                firstVisibleTextMs !== null && firstVisibleTextMs <= slo.firstTokenTargetMs,
              fallback: chunk.replyMessageId.startsWith('fallback_'),
            });
            await s.writeSSE({
              event: 'done',
              data: JSON.stringify({ replyMessageId: chunk.replyMessageId }),
            });
          }
        }
      } catch {
        log.error('turn.relay_error', {
          pseudoId: childId,
          sessionId,
          reason: 'pet_relay_failed',
        });
        await s.writeSSE({
          event: 'delta',
          data: JSON.stringify({
            text: deps.safeModeCopy[child.gradeBand] ? fallbackReply(child.gradeBand) : '',
          }),
        });
        await s.writeSSE({
          event: 'done',
          data: JSON.stringify({ replyMessageId: `fallback_${messageId}` }),
        });
      }
    });
  });
}

function fallbackReply(g: GradeBand): string {
  return g === 'low'
    ? 'ごめんね、いま うまく ことばが でてこない。でも ここに いるよ。'
    : 'ごめんね、今うまく言葉が出てこない。でもここにいるよ。';
}
