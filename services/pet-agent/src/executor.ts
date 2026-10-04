import { createHmac } from 'node:crypto';

import { FieldValue, type Firestore, type Transaction } from '@google-cloud/firestore';
import {
  childPath,
  SAFETY_TOOLS,
  type ChildRecord,
  type FirestoreSessionService,
  type PetToolExecutor,
  type TurnContext,
  type PetToolName,
} from '@ijime/agent-core';
import { PET_REQUEST_TYPES, type PetRequestType } from '@ijime/api-types';
import { agent, island, retention } from '@ijime/config';
import { ApiHttpError, type Logger, type Publisher } from '@ijime/service-kit';
import { gamePromptsFor, loadGames, type GameCatalog, type Kb } from '@ijime/kb-loader';

import { asDate, consultationPending, jstParts, readChildContext } from './context.js';

export async function assertSession(
  db: Firestore,
  child: ChildRecord,
  sessionId: string,
  safety = false,
) {
  const base = childPath(child.familyId, child.childId);
  const c = await db.doc(base).get();
  const session = await db.doc(`${base}/sessions/${sessionId}`).get();
  if (!c.exists || c.get('status') !== 'active' || !session.exists)
    throw new ApiHttpError('NOT_FOUND', 'unknown active session');
  if (session.get('endedAt') || (!safety && session.get('safeMode')))
    throw new ApiHttpError('PERMISSION_DENIED', 'session is not available');
  if (
    !safety &&
    !(await db.collection(`${base}/crisisEvents`).where('status', '==', 'open').limit(1).get())
      .empty
  )
    throw new ApiHttpError('PERMISSION_DENIED', 'child safety mode is active');
}

export async function reserveHttpToolCall(
  db: Firestore,
  child: ChildRecord,
  ctx: TurnContext,
  name: PetToolName,
  args: unknown,
): Promise<boolean> {
  if (SAFETY_TOOLS.has(name)) return true;
  const hash = (value: unknown) =>
    createHmac('sha256', child.dek).update(JSON.stringify(value)).digest('hex');
  const ref = db.doc(
    `${childPath(child.familyId, child.childId)}/sessions/${ctx.sessionId}/toolBudgets/${hash(ctx.operationId ?? ctx.sessionId)}`,
  );
  const callId = hash([name, args]);
  return db.runTransaction(async (tx) => {
    const owner = await tx.get(db.doc(childPath(child.familyId, child.childId)));
    const session = await tx.get(
      db.doc(`${childPath(child.familyId, child.childId)}/sessions/${ctx.sessionId}`),
    );
    const data = await tx.get(ref);
    if (!owner.exists || owner.get('status') !== 'active' || !session.exists)
      throw new ApiHttpError('PERMISSION_DENIED', 'session is not available');
    const calls = (data.get('calls') as string[] | undefined) ?? [];
    if (calls.includes(callId)) return true;
    if (calls.length >= agent.maxToolCallsPerTurn) return false;
    tx.set(ref, {
      calls: [...calls, callId],
      expireAt: new Date(Date.now() + retention.sessionsDays * 86_400_000),
    });
    return true;
  });
}

export function createExecutor(input: {
  db: Firestore;
  kb: Kb;
  sessions: FirestoreSessionService;
  child: ChildRecord;
  sessionId: string;
  searchSkill: (query: string) => Promise<string[]>;
  logger: Logger;
  publish: Publisher['publish'];
  onCrisis?: (id: string) => void;
}): PetToolExecutor {
  const { db, child, sessions, sessionId } = input;
  const base = childPath(child.familyId, child.childId);
  let gamesCache: Promise<GameCatalog> | undefined;
  const sessionRef = db.doc(`${base}/sessions/${sessionId}`);
  const verify = (ctx: TurnContext) => {
    if (ctx.childId !== child.childId || ctx.sessionId !== sessionId)
      throw new ApiHttpError('PERMISSION_DENIED', 'tool context mismatch');
  };
  // Hashes are keyed with the child's DEK so short private arguments cannot be guessed.
  const operation = (ctx: TurnContext, name: string, args: unknown) =>
    createHmac('sha256', child.dek)
      .update(JSON.stringify([sessionId, ctx.operationId ?? sessionId, name, args]))
      .digest('hex');
  const atomic = async <T extends Record<string, unknown>>(
    ctx: TurnContext,
    name: string,
    args: unknown,
    safety: boolean,
    write: (tx: Transaction, id: string) => Promise<T>,
  ): Promise<T> => {
    verify(ctx);
    const id = operation(ctx, name, args);
    const receipt = sessionRef.collection('toolReceipts').doc(id);
    return db.runTransaction(async (tx) => {
      const owner = await tx.get(db.doc(base));
      const session = await tx.get(sessionRef);
      const previous = await tx.get(receipt);
      const openCrisis = safety
        ? undefined
        : await tx.get(
            db.collection(`${base}/crisisEvents`).where('status', '==', 'open').limit(1),
          );
      if (!owner.exists || owner.get('status') !== 'active' || !session.exists)
        throw new ApiHttpError('NOT_FOUND', 'unknown active session');
      if (session.get('endedAt') || (!safety && session.get('safeMode')))
        throw new ApiHttpError('PERMISSION_DENIED', 'session is not available');
      if (openCrisis && !openCrisis.empty)
        throw new ApiHttpError('PERMISSION_DENIED', 'child safety mode is active');
      if (
        name === 'record_mood' &&
        session.get('channel') === 'voice' &&
        owner.get('dataSources.voice') === false
      )
        throw new ApiHttpError('DATA_SOURCE_DISABLED', 'voice_data_source_disabled');
      if (previous.exists) return previous.get('result') as T;
      const result = await write(tx, id);
      tx.create(receipt, {
        tool: name,
        result,
        createdAt: new Date(),
        expireAt: new Date(Date.now() + retention.sessionsDays * 86_400_000),
      });
      return result;
    });
  };
  return {
    getChildContext: async (ctx) => {
      verify(ctx);
      await assertSession(db, child, sessionId);
      return readChildContext(db, input.kb, child);
    },
    searchSkill: async (ctx, query) => {
      verify(ctx);
      await assertSession(db, child, sessionId);
      return input.searchSkill(query);
    },
    recordMood: async (ctx, weather) => {
      const result = await atomic(ctx, 'record_mood', weather, false, async (tx, id) => {
        const now = new Date();
        const jst = jstParts(now);
        tx.create(db.doc(`${base}/moodCheckins/${id}`), {
          weather,
          localDate: jst.date,
          localHour: jst.hour,
          createdAt: now,
        });
        return { checkinId: id };
      });
      // Publication is outside the transaction; retries republish the committed ID.
      // The fallback also supports receipts created by the previous { ok: true } implementation.
      const checkinId = result.checkinId ?? operation(ctx, 'record_mood', weather);
      try {
        await input.publish('checkin.created', { childId: child.childId, kind: 'mood', checkinId });
      } catch {
        throw new Error('checkin_publish_failed');
      }
    },
    remember: async (ctx, content, category) =>
      atomic(ctx, 'remember', [content, category], false, async (tx, id) => {
        const path = `${base}/memoryProposals`;
        tx.create(db.doc(`${path}/${id}`), {
          contentEnc: sessions.encryptForChild(child, content, `${path}#contentEnc`),
          category,
          status: 'pending',
          characterId: child.characterId,
          petId: child.petId,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + retention.idempotencyKeyHours * 3_600_000),
        });
        return { proposalId: id, status: 'pending' as const };
      }),
    recall: async (ctx, topic) => {
      verify(ctx);
      await assertSession(db, child, sessionId);
      const path = `${base}/memories`;
      const snap = await db
        .collection(path)
        .orderBy('createdAt', 'desc')
        .limit(agent.contextHistoryTurns * agent.recallMaxMemories)
        .get();
      const terms = [...new Intl.Segmenter('ja', { granularity: 'word' }).segment(topic)]
        .filter(
          (part) =>
            (part.isWordLike &&
              /\p{Script=Han}|\p{Script=Katakana}|[a-zA-Z0-9]/u.test(part.segment)) ||
            (part.isWordLike && part.segment.length > 1),
        )
        .map((part) => part.segment.toLowerCase());
      if (terms.length === 0) return [];
      const now = new Date();
      return snap.docs
        .flatMap((doc) => {
          const data = doc.data();
          if (
            data['deletedAt'] ||
            data['status'] === 'pending' ||
            data['status'] === 'rejected' ||
            (!data['consentedAt'] &&
              !data['consentAt'] &&
              !data['acceptedAt'] &&
              data['status'] !== 'accepted') ||
            data['characterId'] !== child.characterId ||
            (data['petId'] && data['petId'] !== child.petId) ||
            (asDate(data['expiresAt']) ?? asDate(data['expireAt']) ?? new Date(8640000000000000)) <=
              now
          )
            return [];
          const text = sessions.decryptForChild(
            child,
            Buffer.from(data['contentEnc']),
            `${path}#contentEnc`,
          );
          const score = terms.filter((term) => text.toLowerCase().includes(term)).length;
          return score > 0 ? [{ text, score }] : [];
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, agent.recallMaxMemories)
        .map((m) => m.text);
    },
    suggestGame: async (ctx, game) => {
      if (!PET_REQUEST_TYPES.includes(game as PetRequestType)) return false;
      const type = game as PetRequestType;
      const games = await (gamesCache ??= loadGames(input.kb));
      const candidates = gamePromptsFor(games, type, child.gradeBand);
      if (candidates.length === 0) return false;
      const result = await atomic(ctx, 'suggest_game', game, false, async (tx, id) => {
        const ref = db.doc(`${base}/toolUsage/suggest_game`);
        const saved = await tx.get(ref);
        const recentRequests = await tx.get(
          db
            .collection(`${base}/petRequests`)
            .orderBy('offeredAt', 'desc')
            .limit(island.recentPromptMemory),
        );
        const now = new Date();
        const cutoff = now.getTime() - 7 * 86_400_000;
        const timestamps = (saved.get('timestamps') as unknown[] | undefined) ?? [];
        const recent = timestamps
          .map(asDate)
          .filter((date): date is Date => date !== undefined && date.getTime() > cutoff);
        if (recent.length >= agent.suggestGameWeeklyLimit) return { allowed: false as const };
        const used = new Set(recentRequests.docs.map((d) => d.get('promptId') as string));
        const fresh = candidates.filter((c) => !used.has(c.prompt.id));
        const pool = fresh.length > 0 ? fresh : candidates;
        const pick = pool[parseInt(id.slice(0, 8), 16) % pool.length]!;
        const requestId = `req_${id}`;
        tx.set(ref, {
          timestamps: [...recent, now],
          expireAt: new Date(now.getTime() + 7 * 86_400_000),
        });
        tx.create(db.doc(`${base}/petRequests/${requestId}`), {
          type,
          promptId: pick.prompt.id,
          rewardItemId: pick.prompt.reward_item,
          status: 'offered',
          offeredAt: now,
          expiresAt: new Date(now.getTime() + island.petRequestExpiresDays * 86_400_000),
          sessionId,
        });
        return { allowed: true as const, requestId };
      });
      return result.allowed ? { requestId: result.requestId } : false;
    },
    startTellAdult: async (ctx) =>
      atomic(ctx, 'start_tell_adult', {}, false, async (tx, id) => {
        const candidates = await tx.get(
          db
            .collection(`${base}/consultations`)
            .orderBy('offeredAt', 'desc')
            .limit(agent.contextHistoryTurns),
        );
        const now = new Date();
        const pending = candidates.docs.find((d) => consultationPending(d.data(), now));
        if (pending) {
          if (pending.get('choice') === 'not_now')
            tx.update(pending.ref, {
              choice: FieldValue.delete(),
              choiceAt: FieldValue.delete(),
              followUpAt: FieldValue.delete(),
              offeredAt: now,
              offerCount: (pending.get('offerCount') as number) + 1,
            });
          return { consultationId: pending.id };
        }
        const consultationId = `help_${id}`;
        tx.create(db.doc(`${base}/consultations/${consultationId}`), {
          assessmentId: 'child_initiated',
          level: 'l2',
          source: 'child_initiated',
          offeredAt: now,
          offerCount: 1,
          sessionId,
        });
        return { consultationId };
      }),
    escalateCrisis: async (ctx, reason) => {
      const result = await atomic(ctx, 'escalate_crisis', reason, true, async (tx, id) => {
        const crisisId = `agent_${id}`;
        tx.create(db.doc(`${base}/crisisEvents/${crisisId}`), {
          triggerType: 'text',
          sourceRef: sessionRef.path,
          detection: { source: 'agent_tool', reason, familyHarmStatus: 'unknown' },
          familyHarmSuspected: true,
          timeline: [{ step: 'agent_escalate', at: new Date() }],
          status: 'open',
          createdAt: new Date(),
        });
        tx.update(sessionRef, { safeMode: true });
        return { crisisId };
      });
      input.logger.warn('crisis.agent_escalate', { crisisId: result.crisisId, reason });
      input.onCrisis?.(result.crisisId);
      return result;
    },
  };
}
