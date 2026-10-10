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
  isPaused,
  routingOfCheck,
  routingOfRecord,
  type CrisisDetector,
  type SafeModeCopy,
} from '@ijime/crisis-detector';
import {
  ApiHttpError,
  type CrisisRecheckRequester,
  type Logger,
  type ServiceApp,
  type ServiceEnv,
} from '@ijime/service-kit';
import { checkWithinBudget } from './model-budget.js';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { childAuth, type AuthEnv, type AuthOptions } from './auth.js';
import type { PetAgentClient } from './pet-agent-client.js';
import { persistSubmission } from './submission-store.js';
import { chatSafety, claimReply, pendingReview } from './chat-recovery.js';

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
  // モデルが使えず入力を保留したときにペットが話す定型文（kb templates/model_unavailable.ja.yaml）
  pausedReplies: Record<GradeBand, string>;
  requestRecheck: CrisisRecheckRequester;
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
      items: list.sessions
        .filter((s) => s.state['proactive'] !== true)
        .map((s) => ({
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

  chat.get('/sessions/:sessionId/safety', async (c) => {
    const deps = await getDeps();
    const { childId } = c.get('child');
    const sessionId = c.req.param('sessionId');
    const child = await deps.directory.lookup(childId);
    const session = await deps.sessions.getSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId,
      config: { numRecentEvents: 0 },
    });
    if (!child || !session) throw new ApiHttpError('NOT_FOUND', 'unknown session');
    c.header('Cache-Control', 'no-store');
    return c.json(await chatSafety(deps, child, sessionId));
  });

  chat.on(
    'POST',
    ['/sessions/:sessionId/messages', '/sessions/:sessionId/messages/:messageId/reply'],
    async (c) => {
      const requestStarted = performance.now();
      const deps = await getDeps();
      const { childId } = c.get('child');
      const sessionId = c.req.param('sessionId');
      const retryId = c.req.param('messageId');
      if (retryId && !/^[a-zA-Z0-9_-]{1,200}$/.test(retryId))
        throw new ApiHttpError('INVALID_ARGUMENT', 'invalid message');
      const child = await deps.directory.lookup(childId);
      if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
      const session = await deps.sessions.getSession({
        appName: PET_APP_NAME,
        userId: childId,
        sessionId,
        config: { numRecentEvents: 3 },
      });
      if (!session) throw new ApiHttpError('NOT_FOUND', 'unknown session');
      const context = retryId
        ? await deps.sessions.readMessageContext(childId, sessionId, retryId, 0)
        : undefined;
      if (retryId && (!context || context.message.role !== 'child'))
        throw new ApiHttpError('NOT_FOUND', 'unknown message');
      const parsed = sendMessageSchema.safeParse(
        retryId
          ? {
              text: context!.message.text,
              inputMode: 'typed',
              clientSentAt: new Date().toISOString(),
            }
          : await c.req.json().catch(() => null),
      );
      if (!parsed.success)
        throw new ApiHttpError('INVALID_ARGUMENT', 'メッセージの形式が正しくありません');
      const req: SendMessageReq = {
        text: parsed.data.text,
        inputMode: parsed.data.inputMode,
        clientSentAt: parsed.data.clientSentAt,
        ...(parsed.data.typing ? { typing: parsed.data.typing } : {}),
      };
      const log = deps.logger;
      const base = `families/${child.familyId}/children/${childId}`;
      const [activeCrises, storedSession] = await Promise.all([
        deps.db.collection(`${base}/crisisEvents`).where('status', '==', 'open').limit(1).get(),
        deps.db.doc(`${base}/sessions/${sessionId}`).get(),
      ]);
      if (!activeCrises.empty || storedSession.get('safeMode') === true) {
        const active = activeCrises.docs[0];
        const { message, resources } = crisisResponse({
          familyHarmSuspected: routingOfRecord(active?.data() ?? {}).familyHarmSuspected,
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
      const check = retryId
        ? {
            hit: false,
            method: 'none' as const,
            category: 'none' as const,
            confidence: 0,
            keywordMatched: false,
            familyHarmSuspected: false,
            latencyMs: 0,
          }
        : await checkWithinBudget(deps, child, base, {
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

      // モデルが使えず、キーワードにもヒットしない：ペットに渡さず、危機とも判定せず、メッセージは再審査待ちにする
      if (isPaused(check)) {
        const { messageId } = await deps.sessions.writeChildMessage(childId, sessionId, {
          text: req.text,
          inputMode: req.inputMode,
          ...(req.typing ? { typing: req.typing } : {}),
          crisisCheck: {
            hit: false,
            method: check.method,
            score: 0,
            checkedAt: new Date(),
            pendingReview: true,
          },
        });
        const batch = deps.db.batch();
        batch.update(deps.db.doc(`${base}/sessions/${sessionId}`), {
          latestInputMessageId: messageId,
        });
        batch.update(deps.db.doc(`${base}/sessions/${sessionId}/messages/${messageId}`), {
          replyState: 'awaiting_review',
        });
        await batch.commit();
        const queued = await deps
          .requestRecheck({
            familyId: child.familyId,
            childId,
            sessionId,
            messageId,
            channel: 'text',
          })
          .then(
            () => true,
            () => false,
          );
        if (queued) log.warn('crisis.paused', { pseudoId: childId, sessionId, messageId });
        else
          log.error('crisis.recheck_enqueue_failed', { pseudoId: childId, sessionId, messageId });
        return streamSSE(c, async (s) => {
          await s.writeSSE({ event: 'meta', data: JSON.stringify({ messageId, safeMode: false }) });
          await s.writeSSE({
            event: 'action',
            data: JSON.stringify({ type: 'set_expression', expression: 'sleepy' }),
          });
          await s.writeSSE({
            event: 'action',
            data: JSON.stringify({ type: 'show_help_resources' }),
          });
          await s.writeSSE({
            event: 'review',
            data: JSON.stringify(pendingReview(deps, child, messageId)),
          });
          await s.writeSSE({
            event: 'delta',
            data: JSON.stringify({ text: deps.pausedReplies[child.gradeBand] }),
          });
          await s.writeSSE({
            event: 'done',
            data: JSON.stringify({ replyMessageId: `paused_${messageId}` }),
          });
        });
      }

      // Crisis handling stays available even after the ordinary conversation budget is exhausted.
      if (retryId) await claimReply(deps, child, sessionId, retryId);
      if (!check.hit && !retryId) {
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

      const { messageId } = retryId
        ? { messageId: retryId }
        : await deps.sessions.writeChildMessage(childId, sessionId, {
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
      if (!retryId) {
        const batch = deps.db.batch();
        batch.update(deps.db.doc(`${base}/sessions/${sessionId}`), {
          latestInputMessageId: messageId,
        });
        batch.update(deps.db.doc(`${base}/sessions/${sessionId}/messages/${messageId}`), {
          replyState: check.hit ? 'complete' : 'generating',
        });
        await batch.commit();
        await deps.publish('message.created', {
          familyId: child.familyId,
          childId,
          sessionId,
          messageId,
          channel: 'text',
        });
      }

      return streamSSE(c, async (s) => {
        await s.writeSSE({
          event: 'meta',
          data: JSON.stringify({ messageId, safeMode: check.hit }),
        });
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
          const routing = routingOfCheck(check);
          await deps.publish('crisis.detected', { childId, crisisId: crisisRef.id, ...routing });
          log.warn('crisis.detected', { pseudoId: childId, crisisId: crisisRef.id, ...routing });
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
              const routing = routingOfRecord(record.data() ?? {});
              await deps.sessions.markSafeMode(childId, sessionId);
              await deps.publish('crisis.detected', {
                childId,
                crisisId: chunk.crisisId,
                ...routing,
              });
              log.warn('crisis.detected', {
                pseudoId: childId,
                crisisId: chunk.crisisId,
                source: 'agent_tool',
                ...routing,
              });
              const { message, resources } = crisisResponse({
                familyHarmSuspected: routing.familyHarmSuspected,
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
              const retryable =
                chunk.replyMessageId.startsWith('fallback_') && chunk.retryable === true;
              await deps.db
                .doc(`${base}/sessions/${sessionId}/messages/${messageId}`)
                .update({ replyState: retryable ? 'retryable' : 'complete' });
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
                data: JSON.stringify({ replyMessageId: chunk.replyMessageId, retryable }),
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
    },
  );
}

function fallbackReply(g: GradeBand): string {
  return g === 'low'
    ? 'ごめんね、いま うまく ことばが でてこない。でも ここに いるよ。'
    : 'ごめんね、今うまく言葉が出てこない。でもここにいるよ。';
}
