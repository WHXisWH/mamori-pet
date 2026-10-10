import { randomUUID } from 'node:crypto';

import type { OutputFilter } from '@ijime/agent-core';
import type {
  CrisisHitCategory,
  GradeBand,
  HelpResource,
  PetAction,
  PubSubTopic,
  VoiceServerMessage,
} from '@ijime/api-types';
import { voice as voiceConfig } from '@ijime/config';
import {
  isPaused,
  routingOfCheck,
  type CrisisCheck,
  type CrisisDetector,
  type CrisisRouting,
} from '@ijime/crisis-detector';
import type { CrisisRecheckRequester, Logger } from '@ijime/service-kit';

import { analyzeUtterance, speechRate, VadSegmenter, type Utterance } from './features.js';
import { VoiceGate, type GateInput } from './gate.js';
import type { LiveEvent, LiveSession } from './live.js';
import type { VoiceStore } from './store.js';

export type EndReason = Extract<VoiceServerMessage, { type: 'end' }>['reason'];

export type VoiceCopy = {
  safeReply: string;
  retry: string;
  // モデルが利用できずこの発話が保留になったときは、子どもにもう一度話すよう頼む
  paused: string;
  crisis: (familyHarmSuspected: boolean) => { message: string; resources: HelpResource[] };
};

export type VoiceSessionDeps = {
  child: { childId: string; familyId: string; gradeBand: GradeBand };
  sessionId: string;
  detector: CrisisDetector;
  filter: OutputFilter;
  store: VoiceStore;
  publish: (topic: PubSubTopic, payload: Record<string, unknown>) => Promise<void>;
  requestRecheck: CrisisRecheckRequester;
  copy: VoiceCopy;
  send: (out: VoiceServerMessage | Buffer) => void;
  closeSocket: () => void;
  onEnd?: () => void;
  logger: Logger;
  countMorae: (text: string) => Promise<number>;
  transcriptTimeoutMs?: number;
  idleTimeoutMs?: number;
  // 当日の残り音声時間。尽きたら end（limit）を送る
  maxDurationMs?: number;
};

const PRIOR_TURNS = 3;
// 最終の文字起こしを待つ間、特徴計算のために保持する子どもの音声フレーム数の上限（約 60 秒）
const MAX_FEATURE_FRAMES = Math.ceil(60_000 / voiceConfig.frameMs);

// 1回の音声セッション：子どもの音声 → ローカルでの発話区切りと特徴計算 → Live。Live のイベント → 危機検知とゲート → クライアント。
// 不変条件：子どもの発話の最終文字起こしが完全な検査を通るまで、ペットの出力は1バイトも出さない。
// 危機のあとはペットの出力を一切出さない。音声はメモリ上にしか置かない。
export class VoiceSession {
  private readonly gate = new VoiceGate();
  private readonly connectionId = randomUUID();
  private readonly vad = new VadSegmenter();
  private live: LiveSession | undefined;
  private utterances: Utterance[] = [];
  private priorTurns: string[] = [];
  // 子どもの新しい発話の文字起こし断片が届いていて、その発話の最終文字起こしがまだ届いていない
  private childOpen = false;
  // 直近の発話の最終文字起こしは検査を通過済み。子どもの側が静かになるのを待ってからペットの出力を放出する
  private passedFinal = false;
  private epoch = 0;
  private checkedEpoch = -1;
  private lastFinal: { epoch: number; text: string } | undefined;
  private latestCheck: { epoch: number; check: CrisisCheck } | undefined;
  private heldPetOutputs = 0;
  private petTurnText = '';
  private petFiltered = false;
  private pendingPetTranscript: string | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Set<Promise<unknown>>();
  private transcriptTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private limitTimer: NodeJS.Timeout | undefined;
  private attachedAt: number | undefined;
  private ended = false;
  private revoked = false;
  private crisisId: Promise<string> | undefined;
  private endedPromise: Promise<void> | undefined;

  constructor(private readonly deps: VoiceSessionDeps) {}

  get isEnded(): boolean {
    return this.ended;
  }

  get toolTurnId(): string {
    return `${this.deps.sessionId}:${this.connectionId}:${this.epoch}`;
  }

  get canExecuteTools(): boolean {
    return (
      !this.ended &&
      this.checkedEpoch === this.epoch &&
      !this.childOpen &&
      !this.vad.inUtterance &&
      (this.gate.phase === 'listening' || this.gate.phase === 'releasing')
    );
  }

  attach(live: LiveSession): Promise<void> {
    if (this.ended) return live.close();
    this.live = live;
    this.attachedAt = Date.now();
    if (this.deps.maxDurationMs !== undefined) {
      this.limitTimer = setTimeout(() => void this.end('limit'), this.deps.maxDurationMs);
      this.limitTimer.unref();
    }
    this.resetIdle();
    return (async () => {
      for await (const ev of live.events) this.onLive(ev);
      await this.end('error');
    })();
  }

  onAudio(frame: Buffer): void {
    if (this.ended) return;
    for (const ev of this.vad.push(frame)) {
      if (ev.type === 'speech_start') {
        this.childSpeech();
      } else {
        this.utterances.push(ev.utterance);
        this.trimUtterances();
        this.armTranscriptTimer();
        this.tryRelease();
      }
    }
    if (this.vad.inUtterance) this.resetIdle();
    this.live?.sendAudio(frame);
  }

  onPetAction(action: PetAction): void {
    if (this.ended) return;
    if (action.type === 'show_help_resources') {
      this.deps.send({ type: 'action', action });
      return;
    }
    if (this.epoch === 0) return;
    this.apply({ type: 'pet_action', action });
  }

  // ペットが escalate_crisis を呼んだ：検知でヒットしたときと同じ中断経路を通る
  async escalate(category: CrisisHitCategory): Promise<{ crisisId: string }> {
    if (this.revoked) throw new Error('voice_access_revoked');
    if (this.gate.phase !== 'crisis') {
      this.deps.logger.warn('crisis.agent_escalate', {
        pseudoId: this.deps.child.childId,
        sessionId: this.deps.sessionId,
        category,
      });
      const check = this.latestCheck?.epoch === this.epoch ? this.latestCheck.check : undefined;
      // 今回の検知で家庭内の危害と判定済みなら検知結果を優先し、ペットのカテゴリで上書きさせない
      const routing =
        check?.availability !== 'unavailable' && check?.familyHarmSuspected
          ? routingOfCheck(check)
          : routingOfCheck({ category });
      this.apply({ type: 'escalate' }, () =>
        this.enterCrisis(routing, { agentCategory: category }),
      );
    }
    return { crisisId: (await this.crisisId?.catch(() => '')) ?? '' };
  }

  stop(): Promise<void> {
    return this.end('stop');
  }

  revoke(): Promise<void> {
    this.revoked = true;
    this.priorTurns = [];
    this.petTurnText = '';
    this.latestCheck = undefined;
    this.lastFinal = undefined;
    this.pendingPetTranscript = undefined;
    this.gate.dispose();
    return this.end('stop');
  }

  end(reason: EndReason): Promise<void> {
    if (this.endedPromise) return this.endedPromise;
    this.ended = true;
    this.deps.onEnd?.();
    clearTimeout(this.transcriptTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.limitTimer);
    const elapsedSeconds =
      this.attachedAt === undefined ? 0 : (Date.now() - this.attachedAt) / 1000;
    this.utterances = [];
    this.pendingPetTranscript = undefined;
    this.vad.discard();
    this.deps.send({ type: 'end', reason });
    this.endedPromise = (async () => {
      await this.live?.close().catch(() => this.logError('voice.close_failed'));
      this.deps.closeSocket();
      await Promise.allSettled([...this.inflight]);
      await this.chain;
      await this.crisisId?.catch(() => undefined);
      if (!this.revoked && elapsedSeconds > 0)
        await this.deps.store
          .recordVoiceSeconds(elapsedSeconds)
          .catch(() => this.logError('voice.usage_failed'));
      if (!this.revoked)
        await this.deps.store.end().catch(() => this.logError('session.end_failed'));
      this.deps.logger.info('voice.session_end', {
        pseudoId: this.deps.child.childId,
        sessionId: this.deps.sessionId,
        reason,
      });
    })();
    return this.endedPromise;
  }

  private onLive(ev: LiveEvent): void {
    if (this.ended) return;
    switch (ev.type) {
      case 'child_partial':
        this.deps.send({ type: 'child_transcript', text: ev.text, final: false });
        if (!this.childOpen) {
          this.childSpeech();
        }
        this.armTranscriptTimer();
        this.resetIdle();
        return;
      case 'child_final':
        // Live may repeat a final without new speech. Identical words after new input
        // still belong to a new epoch and must consume a new turn.
        if (
          !this.childOpen &&
          this.lastFinal?.epoch === this.epoch &&
          this.lastFinal.text === ev.text
        )
          return;
        this.deps.send({ type: 'child_transcript', text: ev.text, final: true });
        // A late final after timeout is still checked, but cannot reopen the audio gate.
        if (!this.childOpen && this.gate.phase !== 'muted') this.childSpeech();
        this.childOpen = false;
        this.lastFinal = { epoch: this.epoch, text: ev.text };
        this.resetIdle();
        this.onChildFinal(ev.text);
        return;
      case 'pet_audio':
        this.petOutput({ type: 'pet_audio', data: ev.data });
        return;
      case 'pet_partial':
        this.onPetText(ev.text);
        return;
      case 'pet_final':
        if (ev.text !== this.petTurnText) {
          const suffix = ev.text.startsWith(this.petTurnText)
            ? ev.text.slice(this.petTurnText.length)
            : ev.text;
          this.onPetText(suffix);
        }
        this.persistPetTurn(ev.text);
        return;
      case 'interrupted':
        this.apply({ type: 'interrupted' });
        return;
      case 'turn_complete':
        this.apply({ type: 'turn_complete' });
        this.petTurnText = '';
        this.petFiltered = false;
        return;
      case 'error':
        this.deps.logger.error('voice.live_error', {
          pseudoId: this.deps.child.childId,
          sessionId: this.deps.sessionId,
          code: 'live_stream_failed',
        });
        void this.end('error');
        return;
    }
  }

  private onChildFinal(text: string): void {
    if (this.gate.phase === 'crisis') return;
    clearTimeout(this.transcriptTimer);
    const epoch = this.epoch;
    const utteranceId = this.toolTurnId;
    const utterances = this.utterances.splice(0);
    const prior = this.priorTurns.slice(-PRIOR_TURNS);
    this.priorTurns.push(text);
    this.priorTurns = this.priorTurns.slice(-PRIOR_TURNS);
    const checked = Promise.resolve()
      .then(() =>
        this.deps.detector.check({
          text,
          gradeBand: this.deps.child.gradeBand,
          priorTurns: prior,
        }),
      )
      // 検知器自体のエラー：キーワードにヒットしていれば危機として扱い、そうでなければモデル利用不可と同じくこの発話を保留する
      .catch((): CrisisCheck => {
        const keyword = this.deps.detector.keywordOnly(text);
        return {
          hit: keyword,
          category: keyword ? 'other' : 'none',
          familyHarmSuspected: false,
          availability: 'unavailable',
          method: keyword ? 'review_timeout' : 'paused',
          keywordMatched: keyword,
          confidence: 0,
          latencyMs: 0,
        };
      });
    const handled = checked.then(async (check) => {
      if (this.revoked) return;
      if (epoch === this.epoch) this.latestCheck = { epoch, check };
      this.deps.logger.info('crisis.check', {
        pseudoId: this.deps.child.childId,
        sessionId: this.deps.sessionId,
        hit: check.hit,
        method: check.method,
        category: check.category,
        latencyMs: Math.round(check.latencyMs),
      });
      if (check.hit) {
        const messageId = this.persistChild(text, check, utterances);
        this.apply({ type: 'full', hit: true }, () =>
          this.enterCrisis(routingOfCheck(check), { messageId, check }),
        );
        return;
      }
      void this.persistChild(text, check, utterances);
      if (isPaused(check)) {
        if (this.ended || epoch !== this.epoch || this.gate.phase !== 'holding') return;
        this.gate.dispose();
        this.pendingPetTranscript = undefined;
        this.passedFinal = false;
        this.checkedEpoch = -1;
        this.deps.send({ type: 'interrupted' });
        this.deps.send({
          type: 'action',
          action: { type: 'set_expression', expression: 'sleepy' },
        });
        this.deps.send({ type: 'pet_transcript', text: this.deps.copy.paused });
        this.deps.send({ type: 'action', action: { type: 'show_help_resources' } });
        return;
      }
      if (this.ended || epoch !== this.epoch || this.gate.phase !== 'holding') return;
      let allowed = false;
      try {
        allowed = await this.deps.store.reserveOrdinaryTurn(utteranceId);
      } catch {
        this.logError('voice.quota_failed');
      }
      if (this.ended || this.revoked || epoch !== this.epoch || this.gate.phase !== 'holding')
        return;
      if (!allowed) {
        this.gate.dispose();
        this.pendingPetTranscript = undefined;
        this.passedFinal = false;
        this.checkedEpoch = -1;
        this.deps.send({ type: 'interrupted' });
        this.deps.send({ type: 'pet_transcript', text: this.deps.copy.safeReply });
        this.deps.send({ type: 'action', action: { type: 'show_help_resources' } });
        return;
      }
      this.checkedEpoch = epoch;
      this.passedFinal = true;
      this.tryRelease();
    });
    this.inflight.add(handled);
    void handled.then(
      () => this.inflight.delete(handled),
      () => {
        this.inflight.delete(handled);
        this.logError('voice.check_failed');
      },
    );
  }

  private persistChild(text: string, check: CrisisCheck, utterances: Utterance[]): Promise<string> {
    const { child, sessionId, store } = this.deps;
    const messageId = this.enqueue(async () => {
      const id = await store.writeChildTranscript(text, check);
      if (this.revoked) return id;
      if (utterances.length) {
        const merged = analyzeUtterance({
          frames: utterances.flatMap((u) => u.frames),
          speech: utterances.flatMap((u) => u.speech),
        });
        const morae = await this.deps.countMorae(text);
        if (this.revoked) return id;
        await store.writeFeatures(id, {
          ...merged,
          speechRate: speechRate(morae, merged.durationMs),
        });
      }
      if (this.revoked) return id;
      // 保留した発話は再審査のあとで signal-worker が message.created を発行する
      if (isPaused(check)) {
        await this.deps
          .requestRecheck({
            familyId: child.familyId,
            childId: child.childId,
            sessionId,
            messageId: id,
            channel: 'voice',
          })
          .then(
            () =>
              this.deps.logger.warn('crisis.paused', {
                pseudoId: child.childId,
                sessionId,
                messageId: id,
              }),
            () =>
              this.deps.logger.error('crisis.recheck_enqueue_failed', {
                pseudoId: child.childId,
                sessionId,
                messageId: id,
              }),
          );
        return id;
      }
      await this.deps.publish('message.created', {
        familyId: child.familyId,
        childId: child.childId,
        sessionId,
        messageId: id,
        channel: 'voice',
      });
      return id;
    });
    return messageId;
  }

  private persistPetTurn(text: string): void {
    if (this.epoch === 0) return;
    if (this.gate.phase === 'crisis' || (this.gate.phase === 'muted' && !this.petFiltered)) return;
    const stored = this.petFiltered ? this.deps.copy.safeReply : text;
    if (this.gate.phase === 'holding') {
      this.pendingPetTranscript = stored;
      return;
    }
    if (this.checkedEpoch !== this.epoch) return;
    void this.enqueue(() => this.deps.store.writePetTranscript(stored));
  }

  private onPetText(text: string): void {
    if (this.epoch === 0) return;
    if (this.petFiltered || this.gate.phase === 'crisis' || this.gate.phase === 'muted') return;
    this.petTurnText += text;
    const verdict = this.deps.filter.check(this.petTurnText);
    if (!verdict.ok) {
      this.petFiltered = true;
      this.deps.logger.info('filter.output', {
        pseudoId: this.deps.child.childId,
        sessionId: this.deps.sessionId,
        blocked: true,
        rule: verdict.ruleId,
      });
      this.apply({ type: 'pet_filtered' });
      return;
    }
    this.petOutput({ type: 'pet_text', text });
  }

  private petOutput(input: GateInput): void {
    if (this.epoch === 0) return;
    if (this.gate.phase === 'holding') this.heldPetOutputs += 1;
    this.resetIdle();
    this.apply(input);
  }

  private childSpeech(): void {
    if (this.ended || this.gate.phase === 'crisis') return;
    this.epoch += 1;
    this.childOpen = true;
    this.passedFinal = false;
    this.checkedEpoch = -1;
    this.lastFinal = undefined;
    this.pendingPetTranscript = undefined;
    this.petTurnText = '';
    this.petFiltered = false;
    this.heldPetOutputs = 0;
    this.apply({ type: 'child_speech' });
    this.armTranscriptTimer();
  }

  private tryRelease(): void {
    if (!this.passedFinal || this.childOpen || this.vad.inUtterance) return;
    this.passedFinal = false;
    if (this.gate.phase === 'holding') {
      this.apply({ type: 'full', hit: false });
      const stored = this.pendingPetTranscript;
      this.pendingPetTranscript = undefined;
      if (stored !== undefined) void this.enqueue(() => this.deps.store.writePetTranscript(stored));
    }
  }

  private armTranscriptTimer(): void {
    clearTimeout(this.transcriptTimer);
    if (this.ended) return;
    this.transcriptTimer = setTimeout(
      () => this.onTranscriptTimeout(),
      this.deps.transcriptTimeoutMs ?? voiceConfig.transcriptTimeoutMs,
    );
    this.transcriptTimer.unref();
  }

  private onTranscriptTimeout(): void {
    if (this.gate.phase !== 'holding') return;
    const held = this.heldPetOutputs;
    this.heldPetOutputs = 0;
    this.utterances = [];
    this.childOpen = false;
    this.passedFinal = false;
    this.checkedEpoch = -1;
    // ペットの出力を何も保留していないとき（たいていは雑音）は、子どもにもう一度話すよう頼まなくてよい
    const outs = this.gate.step({ type: 'transcript_timeout' });
    if (held > 0) this.emit(outs);
  }

  private resetIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.ended) return;
    this.idleTimer = setTimeout(
      () => void this.end('timeout'),
      this.deps.idleTimeoutMs ?? voiceConfig.idleTimeoutMs,
    );
    this.idleTimer.unref();
  }

  private apply(input: GateInput, onCrisis?: () => void): void {
    const outs = this.gate.step(input);
    if (outs.some((o) => o.kind === 'crisis')) {
      // 危機：まず止める（ゲートはもうペットの出力を出さない）。そのうえで子どもに定型文を返す
      onCrisis?.();
      return;
    }
    this.emit(outs);
  }

  private emit(outs: ReturnType<VoiceGate['step']>): void {
    for (const o of outs) {
      if (o.kind === 'audio') this.deps.send(o.data);
      else if (o.kind === 'message') this.deps.send(o.message);
      else if (o.kind === 'safe_reply')
        this.deps.send({ type: 'pet_transcript', text: this.deps.copy.safeReply });
      else if (o.kind === 'retry')
        this.deps.send({ type: 'pet_transcript', text: this.deps.copy.retry });
    }
  }

  private enterCrisis(
    routing: CrisisRouting,
    source:
      { messageId: Promise<string>; check: CrisisCheck } | { agentCategory: CrisisHitCategory },
  ): void {
    const { child, sessionId, store, logger } = this.deps;
    const { message, resources } = this.deps.copy.crisis(routing.familyHarmSuspected);
    if (!this.ended) this.deps.send({ type: 'crisis', message, resources });
    this.crisisId = (async () => {
      const ref =
        'check' in source
          ? { messageId: await source.messageId, check: source.check }
          : { agentCategory: source.agentCategory, routing };
      if (this.revoked) return '';
      await store.markSafeMode();
      if (this.revoked) return '';
      const crisisId = await store.recordCrisis(ref);
      if (this.revoked) return '';
      await this.deps.publish('crisis.detected', { childId: child.childId, crisisId, ...routing });
      logger.warn('crisis.detected', {
        pseudoId: child.childId,
        sessionId,
        crisisId,
        trigger: 'voice',
        ...routing,
      });
      return crisisId;
    })();
    this.crisisId.catch(() => this.logError('crisis.persist_failed'));
    void this.end('crisis');
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => {
      if (this.revoked) throw new Error('voice_access_revoked');
      return task();
    });
    this.chain = run.catch(() => this.logError('voice.persist_failed'));
    return run;
  }

  private trimUtterances(): void {
    let frames = this.utterances.reduce((n, u) => n + u.frames.length, 0);
    while (frames > MAX_FEATURE_FRAMES && this.utterances.length > 0) {
      frames -= this.utterances.shift()!.frames.length;
    }
  }

  private logError(event: string): void {
    this.deps.logger.error(event, {
      pseudoId: this.deps.child.childId,
      sessionId: this.deps.sessionId,
      code: 'operation_failed',
    });
  }
}
