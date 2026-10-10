import { createHash } from 'node:crypto';

import type { Firestore } from '@google-cloud/firestore';
import { addVoiceSeconds, childPath, type FirestoreSessionService } from '@ijime/agent-core';
import type { CrisisHitCategory } from '@ijime/api-types';
import { agent, isCrisisLockingChild, retention } from '@ijime/config';
import {
  crisisEventDoc,
  isPaused,
  type CrisisCheck,
  type CrisisRouting,
} from '@ijime/crisis-detector';

import type { UtteranceFeatures } from './features.js';

export type VoiceFeaturesDoc = UtteranceFeatures & { speechRate: number };

// 音声セッションの保存。文字起こしは暗号文としてだけ messages に書き込む。音声はここを通らない
export interface VoiceStore {
  reserveOrdinaryTurn(utteranceId: string): Promise<boolean>;
  writeChildTranscript(text: string, check: CrisisCheck): Promise<string>;
  writePetTranscript(text: string): Promise<string>;
  writeFeatures(messageId: string, features: VoiceFeaturesDoc): Promise<void>;
  recordCrisis(
    input:
      | { messageId: string; check: CrisisCheck }
      | { agentCategory: CrisisHitCategory; routing: CrisisRouting },
  ): Promise<string>;
  markSafeMode(): Promise<void>;
  // このセッションの時間を当日の音声利用分数に加算する
  recordVoiceSeconds(seconds: number): Promise<void>;
  end(): Promise<void>;
}

export class FirestoreVoiceStore implements VoiceStore {
  private readonly base: string;

  constructor(
    private readonly db: Firestore,
    private readonly sessions: FirestoreSessionService,
    private readonly child: { childId: string; familyId: string },
    private readonly sessionId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.base = childPath(child.familyId, child.childId);
  }

  async reserveOrdinaryTurn(utteranceId: string): Promise<boolean> {
    const now = this.now();
    const date = new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
    const usage = this.db.doc(`${this.base}/chatUsage/${date}`);
    const session = this.db.doc(`${this.base}/sessions/${this.sessionId}`);
    const id = `voice-turn-${createHash('sha256').update(utteranceId).digest('hex')}`;
    // The API replaces chatUsage documents, so receipts must live outside that counter.
    const receipt = session.collection('toolReceipts').doc(id);
    return this.db.runTransaction(async (tx) => {
      const owner = await tx.get(this.db.doc(this.base));
      const current = await tx.get(session);
      const previous = await tx.get(receipt);
      const crises = await tx.get(this.db.collection(`${this.base}/crisisEvents`));
      if (
        owner.get('status') !== 'active' ||
        owner.get('dataSources.voice') === false ||
        !current.exists ||
        current.get('endedAt') ||
        current.get('channel') !== 'voice' ||
        current.get('safeMode') === true ||
        crises.docs.some((crisis) => isCrisisLockingChild(crisis.data(), new Date()))
      )
        return false;
      if (previous.exists) return previous.get('result') === true;
      const snapshot = await tx.get(usage);
      const turns = Number(snapshot.get('turns') ?? 0);
      if (!Number.isSafeInteger(turns) || turns < 0) return false;
      const allowed = turns < agent.dailyTurnLimit;
      if (allowed)
        tx.set(usage, { turns: turns + 1, expireAt: new Date(now.getTime() + 2 * 86_400_000) });
      tx.create(receipt, {
        tool: 'voice_turn',
        result: allowed,
        localDate: date,
        createdAt: now,
        expireAt: new Date(now.getTime() + retention.sessionsDays * 86_400_000),
      });
      return allowed;
    });
  }

  async writeChildTranscript(text: string, check: CrisisCheck): Promise<string> {
    const { messageId } = await this.sessions.writeChildMessage(
      this.child.childId,
      this.sessionId,
      {
        text,
        inputMode: 'voice_transcript',
        crisisCheck: {
          hit: check.hit,
          method: check.method,
          score: check.confidence,
          checkedAt: this.now(),
          ...(isPaused(check) ? { pendingReview: true } : {}),
        },
      },
    );
    return messageId;
  }

  async writePetTranscript(text: string): Promise<string> {
    return (await this.sessions.writePetTranscript(this.child.childId, this.sessionId, text))
      .messageId;
  }

  async writeFeatures(messageId: string, f: VoiceFeaturesDoc): Promise<void> {
    const doc: Record<string, unknown> = {
      messageId,
      durationMs: f.durationMs,
      speechRate: f.speechRate,
      pauseRatio: f.pauseRatio,
      createdAt: this.now(),
    };
    if (f.pitchMeanHz !== undefined) doc['pitchMeanHz'] = f.pitchMeanHz;
    if (f.pitchStdHz !== undefined) doc['pitchStdHz'] = f.pitchStdHz;
    await this.db.collection(`${this.base}/sessions/${this.sessionId}/voiceFeatures`).add(doc);
  }

  async recordCrisis(
    input:
      | { messageId: string; check: CrisisCheck }
      | { agentCategory: CrisisHitCategory; routing: CrisisRouting },
  ): Promise<string> {
    const now = this.now();
    const session = `${this.base}/sessions/${this.sessionId}`;
    const doc =
      'check' in input
        ? crisisEventDoc({
            triggerType: 'voice',
            sourceRef: `${session}/messages/${input.messageId}`,
            check: input.check,
            now,
          })
        : {
            triggerType: 'voice',
            sourceRef: session,
            detection: { source: 'agent_tool', category: input.agentCategory },
            ...input.routing,
            timeline: [{ step: 'safe_mode_shown', at: now }],
            status: 'open',
            createdAt: now,
          };
    return (await this.db.collection(`${this.base}/crisisEvents`).add(doc)).id;
  }

  markSafeMode(): Promise<void> {
    return this.sessions.markSafeMode(this.child.childId, this.sessionId);
  }

  recordVoiceSeconds(seconds: number): Promise<void> {
    return addVoiceSeconds(this.db, this.child, this.now(), seconds);
  }

  end(): Promise<void> {
    return this.sessions.endSession(this.child.childId, this.sessionId);
  }
}
