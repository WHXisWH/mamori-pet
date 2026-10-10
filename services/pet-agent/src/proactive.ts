import type { DocumentSnapshot, Transaction } from '@google-cloud/firestore';
import { InMemorySessionService } from '@google/adk';
import {
  PET_APP_NAME,
  childPath,
  fillTemplate,
  runPetTurn,
  type ChildRecord,
} from '@ijime/agent-core';
import type { PetAction, ProactiveTurnReq, ProactiveTurnRes } from '@ijime/api-types';
import { agent as agentConfig, risk } from '@ijime/config';
import { openingsSchema, safeRepliesSchema } from '@ijime/kb-loader';
import { ApiHttpError, proactiveTurnTaskSchema } from '@ijime/service-kit';

import { asDate, jstParts } from './context.js';
import { assertSession } from './executor.js';
import { buildAgent, type PetRuntime } from './runtime.js';

const isNight = (now: Date) => jstParts(now).hour >= risk.lateNightHour;

async function fixedGreeting(
  rt: PetRuntime,
  child: ChildRecord,
  now: Date,
): Promise<ProactiveTurnRes> {
  const text = isNight(now)
    ? (await rt.kb.yaml('prompts/rest-reminders.yaml', safeRepliesSchema)).replies[child.gradeBand]
    : (await rt.kb.yaml('prompts/openings.yaml', openingsSchema)).openings[child.gradeBand][0]!;
  return { greeting: { text, expression: 'caring' }, fallback: true };
}

function greetingContext(owner: DocumentSnapshot, petId: string) {
  return {
    petId: (owner.get('activePetId') as string | undefined) ?? petId,
    memoryRevision: Number(owner.get('memoryRevision') ?? 0),
    modelHistoryResetAt: asDate(owner.get('modelHistoryResetAt')) ?? null,
  };
}

function savedResult(
  doc: DocumentSnapshot,
  context: ReturnType<typeof greetingContext>,
): ProactiveTurnRes | undefined {
  // Legacy receipts have no revocation version and cannot safely replay model content.
  if (
    !doc.get('greeting') ||
    typeof doc.get('fallback') !== 'boolean' ||
    doc.get('petId') !== context.petId ||
    doc.get('memoryRevision') !== context.memoryRevision ||
    (asDate(doc.get('modelHistoryResetAt'))?.getTime() ?? 0) !==
      (context.modelHistoryResetAt?.getTime() ?? 0)
  )
    return undefined;
  return {
    greeting: doc.get('greeting') as ProactiveTurnRes['greeting'],
    ...(doc.get('petRequest')
      ? { petRequest: doc.get('petRequest') as NonNullable<ProactiveTurnRes['petRequest']> }
      : {}),
    fallback: doc.get('fallback') as boolean,
  };
}

/** One model execution per child/date/slot; retries after a lost lease use fixed copy only. */
export async function runProactiveTurn(
  rt: PetRuntime,
  task: ProactiveTurnReq,
  now: () => Date = () => new Date(),
): Promise<ProactiveTurnRes> {
  const parsed = proactiveTurnTaskSchema.safeParse(task);
  const date = parsed.success ? new Date(`${parsed.data.localDate}T00:00:00.000Z`) : undefined;
  if (
    !parsed.success ||
    !/^[a-zA-Z0-9_-]+$/.test(parsed.data.childId) ||
    !date ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== parsed.data.localDate
  )
    throw new ApiHttpError('INVALID_ARGUMENT', 'invalid proactive turn');

  try {
    const child = await rt.directory.lookup(task.childId);
    if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
    const base = childPath(child.familyId, child.childId);
    const turnRef = rt.db.doc(`${base}/proactiveTurns/${task.localDate}-${task.slot}`);
    const usageRef = rt.db.doc(`${base}/chatUsage/${task.localDate}_proactive`);
    const sessionId = `proactive-${task.localDate}-${task.slot}`;
    const sessionRef = rt.db.doc(`${base}/sessions/${sessionId}`);

    const checkAccess = async (tx: Transaction, requireSession = false) => {
      const owner = await tx.get(rt.db.doc(base));
      const session = await tx.get(sessionRef);
      const crises = await tx.get(
        rt.db.collection(`${base}/crisisEvents`).where('status', '==', 'open').limit(1),
      );
      if (!owner.exists || owner.get('status') !== 'active' || (requireSession && !session.exists))
        throw new ApiHttpError('NOT_FOUND', 'unknown active session');
      if (session.get('endedAt') || session.get('safeMode') || !crises.empty)
        throw new ApiHttpError('PERMISSION_DENIED', 'session is not available');
      return { sessionExists: session.exists, context: greetingContext(owner, child.petId) };
    };

    const claim = await rt.db.runTransaction(async (tx) => {
      const { sessionExists, context } = await checkAccess(tx);
      const saved = await tx.get(turnRef);
      const replay = savedResult(saved, context);
      if (replay) return { kind: 'replay', result: replay } as const;
      const at = now();
      if (task.localDate !== jstParts(at).date)
        throw new ApiHttpError('INVALID_ARGUMENT', 'proactive date must be today in JST');
      if (saved.exists) {
        const leaseUntil = asDate(saved.get('leaseUntil'));
        if (leaseUntil && leaseUntil > at)
          throw new ApiHttpError('ALREADY_EXISTS', 'proactive turn is in progress');
        return { kind: 'recover' } as const;
      }
      if (agentConfig.proactiveLeaseMs <= agentConfig.turnTimeoutMs)
        throw new ApiHttpError('MODEL_UNAVAILABLE', 'proactive lease must exceed turn timeout');
      const usage = await tx.get(usageRef);
      const turns = Number(usage.get('turns') ?? 0);
      if (turns >= agentConfig.proactiveDailyLimit)
        throw new ApiHttpError('RATE_LIMITED', 'proactive daily limit reached');
      const expireAt = new Date(at.getTime() + agentConfig.proactiveRetentionDays * 86_400_000);
      const leaseUntil = new Date(at.getTime() + agentConfig.proactiveLeaseMs);
      tx.set(usageRef, { turns: turns + 1, expireAt });
      // Only completed receipts have localDate, so pending jobs cannot hide a home greeting.
      tx.create(turnRef, { status: 'running', leaseUntil, expireAt });
      return { kind: 'run', sessionExists, leaseUntil, context } as const;
    });
    if (claim.kind === 'replay') return claim.result;

    let needsSession = false;
    let result: ProactiveTurnRes;
    if (claim.kind === 'recover' || isNight(now()) || claim.leaseUntil <= now()) {
      result = await fixedGreeting(rt, child, now());
    } else {
      if (!claim.sessionExists)
        await rt.sessions.createSession({
          appName: PET_APP_NAME,
          userId: child.childId,
          sessionId,
          state: { channel: 'text', proactive: true, slot: task.slot },
        });
      await assertSession(rt.db, child, sessionId);
      needsSession = true;
      result = await generateProactiveGreeting(
        rt,
        child,
        sessionId,
        task.slot,
        now,
        claim.leaseUntil,
      );
    }

    // Preload both fixed replies so a transaction retry crossing 23:00 remains model-free.
    const daytime = await fixedGreeting(rt, child, new Date(`${task.localDate}T00:00:00Z`));
    const night = await fixedGreeting(rt, child, new Date(`${task.localDate}T14:00:00Z`));
    const completed = await rt.db.runTransaction(async (tx) => {
      const { context } = await checkAccess(tx, needsSession);
      const saved = await tx.get(turnRef);
      const replay = savedResult(saved, context);
      if (replay) return replay;
      if (!saved.exists) throw new ApiHttpError('MODEL_UNAVAILABLE', 'proactive claim was lost');
      const at = now();
      const expired = claim.kind === 'recover' || claim.leaseUntil <= at;
      const revoked =
        claim.kind === 'run' &&
        (claim.context.petId !== child.petId ||
          claim.context.petId !== context.petId ||
          claim.context.memoryRevision !== context.memoryRevision ||
          (claim.context.modelHistoryResetAt?.getTime() ?? 0) !==
            (context.modelHistoryResetAt?.getTime() ?? 0));
      const body = isNight(at) ? night : expired || revoked ? daytime : result;
      tx.set(turnRef, {
        ...body,
        ...context,
        status: 'completed',
        localDate: task.localDate,
        slot: task.slot,
        createdAt: at,
        expireAt: saved.get('expireAt'),
      });
      return body;
    });
    if (rt.childPush && !completed.fallback) {
      // A daily greeting is best-effort: claim before sending, never send again on task replay.
      const send = await rt.db.runTransaction(async (tx) => {
        const saved = await tx.get(turnRef);
        if (!saved.exists || saved.get('fallback') || saved.get('pushStatus')) return false;
        tx.update(turnRef, { pushStatus: 'claimed', pushClaimedAt: now() });
        return true;
      });
      if (send) {
        let status = 'failed';
        try {
          status = (await rt.childPush.send({ ...task, turnId: turnRef.id })).status;
        } catch {
          rt.logger.warn('agent.proactive_push_failed');
        }
        await rt.db.runTransaction(async (tx) => {
          const current = await tx.get(turnRef);
          if (current.exists && current.get('pushStatus') === 'claimed')
            tx.update(turnRef, { pushStatus: status });
        });
      }
    }
    return completed;
  } catch (error) {
    if (error instanceof ApiHttpError) throw error;
    throw new ApiHttpError('MODEL_UNAVAILABLE', 'proactive turn unavailable');
  }
}

export async function generateProactiveGreeting(
  rt: PetRuntime,
  child: ChildRecord,
  sessionId: string,
  slot: ProactiveTurnReq['slot'],
  now: () => Date = () => new Date(),
  leaseUntil?: Date,
): Promise<ProactiveTurnRes> {
  const fallback = await fixedGreeting(rt, child, now());
  if (isNight(now()) || (leaseUntil && leaseUntil <= now())) return fallback;
  try {
    const text = fillTemplate(await rt.kb.text('prompts/proactive.md'), { slot });
    const actions: PetAction[] = [];
    const agent = await buildAgent(rt, child, sessionId, actions, undefined, sessionId, text, true);
    // Proactive tasks must never load a child's chat transcript or appear as chat messages.
    const sessionService = new InMemorySessionService();
    await sessionService.createSession({ appName: PET_APP_NAME, userId: child.childId, sessionId });
    if (isNight(now()) || (leaseUntil && leaseUntil <= now()))
      return fixedGreeting(rt, child, now());
    const gen = runPetTurn({
      agent,
      sessionService,
      childId: child.childId,
      sessionId,
      text,
      gradeBand: child.gradeBand,
      filter: rt.filter,
      safeReply: fallback.greeting.text,
      actions,
      ...(leaseUntil
        ? {
            turnTimeoutMs: Math.min(
              agentConfig.turnTimeoutMs,
              leaseUntil.getTime() - now().getTime(),
            ),
          }
        : {}),
      onLog: (event, fields) => rt.logger.info(event, { ...fields, pseudoId: child.childId }),
    });
    let step = await gen.next();
    while (!step.done) step = await gen.next();
    const outcome = step.value;
    if (outcome.fallback || !outcome.replyText) return fallback;
    const expression = actions.find((action) => action.type === 'set_expression');
    const request = actions.find((action) => action.type === 'suggest_game');
    return {
      greeting: {
        text: outcome.replyText,
        expression: expression?.type === 'set_expression' ? expression.expression : 'caring',
      },
      ...(request?.type === 'suggest_game' &&
      request.requestId &&
      (request.game === 'drawing' || request.game === 'story' || request.game === 'pet_worry')
        ? { petRequest: { requestId: request.requestId, type: request.game } }
        : {}),
      fallback: false,
    };
  } catch {
    rt.logger.warn('agent.proactive_fallback', { pseudoId: child.childId });
    return fallback;
  }
}
