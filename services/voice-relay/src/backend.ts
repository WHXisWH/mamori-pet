import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

import type { DocumentData, Firestore } from '@google-cloud/firestore';
import type { BaseLlm } from '@google/adk';
import {
  buildPetInstruction,
  childPath,
  createPetAgent,
  createPetTools,
  defaultPetName,
  PET_APP_NAME,
  type ChildContext,
  type ChildDirectory,
  type ChildRecord,
  type FirestoreSessionService,
  type OutputFilter,
} from '@ijime/agent-core';
import type { GradeBand, HelpResource, PubSubTopic, VoiceServerMessage } from '@ijime/api-types';
import { crisisResponse, type CrisisDetector, type SafeModeCopy } from '@ijime/crisis-detector';
import type { Kb } from '@ijime/kb-loader';
import type { Logger } from '@ijime/service-kit';

import { forwardingExecutor, type ToolCaller } from './forwarder.js';
import { openAdkLive, type LiveSession } from './live.js';
import { recentScreenedTopic } from './memory-context.js';
import { VoiceSession } from './session.js';
import { FirestoreVoiceStore } from './store.js';
import { redeemTicket, type TicketOwner } from './tickets.js';

export class VoiceOpenError extends Error {
  constructor(
    readonly reason: 'unknown_child' | 'data_source_disabled' | 'active_crisis' | 'access_revoked',
  ) {
    super(`voice session refused: ${reason}`);
    this.name = 'VoiceOpenError';
  }
}

export type VoiceIo = {
  send: (out: VoiceServerMessage | Buffer) => void;
  closeSocket: () => void;
};

export type OpenedVoice = { session: VoiceSession; live: LiveSession; sessionId: string };

export interface VoiceBackend {
  redeem(ticket: string): Promise<TicketOwner | null>;
  open(owner: TicketOwner, start: { sessionId?: string }, io: VoiceIo): Promise<OpenedVoice>;
}

export type VoiceBackendDeps = {
  db: Firestore;
  directory: ChildDirectory;
  sessions: FirestoreSessionService;
  kb: Kb;
  detector: CrisisDetector;
  filter: OutputFilter;
  safeReplies: Record<GradeBand, string>;
  retryLines: Record<GradeBand, string>;
  safeModeCopy: SafeModeCopy;
  hotlines: HelpResource[];
  publish: (topic: PubSubTopic, payload: Record<string, unknown>) => Promise<void>;
  callTool: ToolCaller;
  // セッションごとに1つのモデルインスタンス。connected は Live 接続の確立時に解決する
  createModel: () => { model: BaseLlm; connected: Promise<void> };
  countMorae: (text: string) => Promise<number>;
  logger: Logger;
  now?: () => Date;
};

function fallbackStatus(child: ChildRecord, now: Date): ChildContext {
  return {
    gradeBand: child.gradeBand,
    characterId: child.characterId,
    localTime: new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(now),
    dayType: 'school_day',
    recentTrend: '',
    careFlag: false,
  };
}

export function createVoiceBackend(deps: VoiceBackendDeps): VoiceBackend {
  const now = deps.now ?? (() => new Date());

  async function resolveSession(child: ChildRecord, wanted?: string): Promise<string> {
    if (wanted) {
      const snap = await deps.db
        .doc(`${childPath(child.familyId, child.childId)}/sessions/${wanted}`)
        .get();
      const d = snap.data();
      // Only an active voice session can be resumed; ended or unsafe sessions stay closed.
      if (d && d['channel'] === 'voice' && d['safeMode'] !== true && !d['endedAt']) return wanted;
    }
    const s = await deps.sessions.createSession({
      appName: PET_APP_NAME,
      userId: child.childId,
      state: { channel: 'voice' },
    });
    return s.id;
  }

  return {
    redeem: (ticket) => redeemTicket(deps.db, ticket, now()),

    async open(owner, start, io) {
      const child = await deps.directory.lookup(owner.childId);
      if (!child || child.familyId !== owner.familyId) throw new VoiceOpenError('unknown_child');
      const childRef = deps.db.doc(childPath(child.familyId, child.childId));
      const childDoc = (await childRef.get()).data();
      const sources = (childDoc?.['dataSources'] ?? {}) as Record<string, boolean>;
      if (sources['voice'] === false) throw new VoiceOpenError('data_source_disabled');
      if (childDoc?.['status'] !== 'active') throw new VoiceOpenError('unknown_child');
      const ref: { session?: VoiceSession } = {};
      const abort = new AbortController();
      let openedLive: LiveSession | undefined;
      let unsubscribe: (() => void) | undefined;
      const cleanup = () => {
        unsubscribe?.();
        unsubscribe = undefined;
      };
      const unchanged = (data: DocumentData | undefined) =>
        data?.['status'] === 'active' &&
        data['dataSources']?.voice !== false &&
        data['activePetId'] === childDoc['activePetId'] &&
        (data['memoryRevision'] ?? 0) === (childDoc['memoryRevision'] ?? 0) &&
        isDeepStrictEqual(data['modelHistoryResetAt'], childDoc['modelHistoryResetAt']);
      const revoke = () => {
        if (abort.signal.aborted) return;
        abort.abort();
        cleanup();
        void ref.session?.revoke();
        void openedLive?.close();
      };
      let firstSnapshot!: () => void;
      const watching = new Promise<void>((resolve) => {
        firstSnapshot = resolve;
      });
      unsubscribe = childRef.onSnapshot(
        (snapshot) => {
          if (!unchanged(snapshot.data())) revoke();
          firstSnapshot();
        },
        () => {
          revoke();
          firstSnapshot();
        },
      );
      const assertActive = () => {
        if (abort.signal.aborted) throw new VoiceOpenError('access_revoked');
      };
      try {
        await watching;
        assertActive();
        // A guardian acknowledgement is not confirmation that the child is safe.
        const crises = await deps.db
          .collection(`${childPath(child.familyId, child.childId)}/crisisEvents`)
          .get();
        if (crises.docs.some((doc) => doc.data()['status'] !== 'closed'))
          throw new VoiceOpenError('active_crisis');
        assertActive();

        const sessionId = await resolveSession(child, start.sessionId);
        assertActive();
        const executor = forwardingExecutor(
          async (name, request) => {
            assertActive();
            const operationId = createHash('sha256')
              .update(ref.session?.toolTurnId ?? sessionId)
              .digest('hex');
            const result = await deps.callTool(name, { ...request, operationId });
            assertActive();
            return result;
          },
          (reason) => ref.session!.escalate(reason),
          () => ref.session?.canExecuteTools === true,
        );
        const ctx = {
          childId: child.childId,
          sessionId,
          gradeBand: child.gradeBand,
          characterId: child.characterId,
        };
        const tools = createPetTools(
          executor,
          ctx,
          (action) => ref.session?.onPetAction(action),
          (name) => {
            deps.logger.warn('tool.forward_failed', {
              pseudoId: child.childId,
              sessionId,
              tool: name,
              code: 'tool_unavailable',
            });
            return { error: 'unavailable' };
          },
          { filter: deps.filter, turnId: () => ref.session?.toolTurnId ?? sessionId },
        );
        const status = await executor
          .getChildContext(ctx)
          .catch(() => fallbackStatus(child, now()));
        assertActive();
        const topic = await recentScreenedTopic({
          db: deps.db,
          sessions: deps.sessions,
          child,
          resetAt: childDoc['modelHistoryResetAt'],
          now: now(),
        });
        assertActive();
        const memories = topic ? await executor.recall(ctx, topic) : [];
        if (!Array.isArray(memories) || memories.some((value) => typeof value !== 'string'))
          throw new Error('invalid_memory_context');
        if (!unchanged((await childRef.get()).data())) revoke();
        assertActive();
        const instruction = await buildPetInstruction(deps.kb, {
          characterId: child.characterId,
          gradeBand: child.gradeBand,
          petName: child.petName || defaultPetName(child.characterId),
          status,
          memories,
          voice: true,
        });
        assertActive();
        const { model, connected } = deps.createModel();
        const agent = createPetAgent({ model, instruction, tools });

        const session = new VoiceSession({
          child: { childId: child.childId, familyId: child.familyId, gradeBand: child.gradeBand },
          sessionId,
          detector: deps.detector,
          filter: deps.filter,
          store: new FirestoreVoiceStore(deps.db, deps.sessions, child, sessionId, now),
          publish: deps.publish,
          copy: {
            safeReply: deps.safeReplies[child.gradeBand],
            retry: deps.retryLines[child.gradeBand],
            crisis: (familyHarmSuspected) =>
              crisisResponse({
                familyHarmSuspected,
                gradeBand: child.gradeBand,
                copy: deps.safeModeCopy,
                hotlines: deps.hotlines,
              }),
          },
          send: io.send,
          closeSocket: io.closeSocket,
          onEnd: cleanup,
          logger: deps.logger,
          countMorae: deps.countMorae,
        });
        ref.session = session;

        const live = await openAdkLive({
          agent,
          sessionService: deps.sessions,
          childId: child.childId,
          sessionId,
          connected,
          signal: abort.signal,
        });
        openedLive = live;
        // Recheck after connection establishment; no ready frame may escape a setup-time revocation.
        if (!unchanged((await childRef.get()).data())) revoke();
        assertActive();
        return { session, live, sessionId };
      } catch (error) {
        cleanup();
        abort.abort();
        await openedLive?.close();
        throw error;
      }
    },
  };
}
