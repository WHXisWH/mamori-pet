import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OutputFilter } from '@ijime/agent-core';
import type { VoiceServerMessage } from '@ijime/api-types';
import { createNoModelDetector, type CrisisCheck } from '@ijime/crisis-detector';
import { FsKbSource, Kb, lexiconSchema, outputFilterSchema } from '@ijime/kb-loader';
import { Logger, type CrisisRecheckTask } from '@ijime/service-kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Pipe, type LiveEvent, type LiveSession } from './live.js';
import { VoiceSession } from './session.js';
import type { VoiceFeaturesDoc, VoiceStore } from './store.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SENTINEL = 'センチネルのことば';
let kb: Kb;

beforeAll(async () => {
  kb = await Kb.load(new FsKbSource(KB_DIR));
});

function tone(ms = 40, hz = 200, amp = 8000): Buffer {
  const n = (16000 * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * hz * i) / 16000)), i * 2);
  return b;
}
const silence = () => Buffer.alloc(1280);

class FakeLive implements LiveSession {
  readonly pipe = new Pipe<LiveEvent>();
  readonly audio: Buffer[] = [];
  closed = false;
  get events() {
    return this.pipe;
  }
  sendAudio(pcm: Buffer) {
    this.audio.push(pcm);
  }
  async close() {
    this.closed = true;
    this.pipe.close();
  }
}

class MemoryStore implements VoiceStore {
  child: { text: string; check: CrisisCheck; id: string }[] = [];
  pet: string[] = [];
  features: { messageId: string; f: VoiceFeaturesDoc }[] = [];
  crises: unknown[] = [];
  safeMode = false;
  ended = false;
  async reserveOrdinaryTurn(_utteranceId: string) {
    return true;
  }
  async writeChildTranscript(text: string, check: CrisisCheck) {
    const id = `m${this.child.length + 1}`;
    this.child.push({ text, check, id });
    return id;
  }
  async writePetTranscript(text: string) {
    this.pet.push(text);
    return `p${this.pet.length}`;
  }
  async writeFeatures(messageId: string, f: VoiceFeaturesDoc) {
    this.features.push({ messageId, f });
  }
  async recordCrisis(input: unknown) {
    this.crises.push(input);
    return `k${this.crises.length}`;
  }
  async markSafeMode() {
    this.safeMode = true;
  }
  voiceSeconds: number[] = [];
  async recordVoiceSeconds(seconds: number) {
    this.voiceSeconds.push(seconds);
  }
  async end() {
    this.ended = true;
  }
}

async function setup(opts: { transcriptTimeoutMs?: number; maxDurationMs?: number } = {}) {
  const live = new FakeLive();
  const store = new MemoryStore();
  const out: (VoiceServerMessage | Buffer)[] = [];
  const published: { topic: string; payload: Record<string, unknown> }[] = [];
  const logs: string[] = [];
  const rechecks: CrisisRecheckTask[] = [];
  let socketClosed = false;
  const detector = createNoModelDetector(await kb.yaml('lexicon/ja.yaml', lexiconSchema));
  const session = new VoiceSession({
    child: { childId: 'c1', familyId: 'f1', gradeBand: 'high' },
    sessionId: 's1',
    detector,
    filter: new OutputFilter(await kb.yaml('rules/output_filter.yaml', outputFilterSchema)),
    store,
    publish: async (topic, payload) => {
      published.push({ topic, payload });
    },
    requestRecheck: async (task) => void rechecks.push(task),
    copy: {
      safeReply: 'SAFE',
      retry: 'RETRY',
      paused: 'PAUSED',
      crisis: (fh) => ({ message: fh ? 'CRISIS_FAMILY' : 'CRISIS', resources: [] }),
    },
    send: (m) => out.push(m),
    closeSocket: () => {
      socketClosed = true;
    },
    logger: new Logger('voice-relay', (l) => logs.push(l)),
    countMorae: async (t) => t.length,
    ...opts,
  });
  const running = session.attach(live);
  const push = (ev: LiveEvent) => live.pipe.push(ev);
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const speak = (frames = 15) => {
    for (let i = 0; i < frames; i++) session.onAudio(tone());
  };
  const quiet = (frames = 20) => {
    for (let i = 0; i < frames; i++) session.onAudio(silence());
  };
  const audioOut = () => out.filter((o): o is Buffer => Buffer.isBuffer(o));
  const messages = () => out.filter((o): o is VoiceServerMessage => !Buffer.isBuffer(o));
  return {
    session,
    detector,
    live,
    store,
    out,
    published,
    logs,
    rechecks,
    running,
    push,
    settle,
    speak,
    quiet,
    audioOut,
    messages,
    socketClosed: () => socketClosed,
  };
}

const petAudio = (n: number): LiveEvent => ({ type: 'pet_audio', data: Buffer.from([n]) });

describe('VoiceSession', () => {
  it('ends with limit when the remaining daily voice time runs out and records the usage', async () => {
    const t = await setup({ maxDurationMs: 30 });
    await t.running;
    expect(t.messages()).toEqual([{ type: 'end', reason: 'limit' }]);
    expect(t.socketClosed()).toBe(true);
    await t.session.end('stop');
    expect(t.store.voiceSeconds).toHaveLength(1);
    expect(t.store.voiceSeconds[0]).toBeGreaterThan(0);
    expect(t.store.ended).toBe(true);
  });

  it('records the session time once on a normal stop', async () => {
    const t = await setup();
    await t.settle();
    await t.session.stop();
    await t.session.stop();
    expect(t.store.voiceSeconds).toHaveLength(1);
    expect(t.messages()).toEqual([{ type: 'end', reason: 'stop' }]);
  });

  it('does not release unmetered initial model output before any child utterance', async () => {
    const t = await setup();
    t.push(petAudio(1));
    t.push({ type: 'pet_final', text: 'UNMETERED' });
    t.session.onPetAction({ type: 'suggest_game', game: 'story' });
    await t.settle();
    expect(t.out).toEqual([]);
    expect(t.store.pet).toEqual([]);
    t.session.onPetAction({ type: 'show_help_resources' });
    expect(t.messages()).toEqual([{ type: 'action', action: { type: 'show_help_resources' } }]);
    await t.session.stop();
  });

  it('waits for both crisis clearance and a quota reservation before releasing output or tools', async () => {
    const t = await setup();
    const checked = deferred<CrisisCheck>();
    const reserved = deferred<boolean>();
    vi.spyOn(t.detector, 'check').mockReturnValue(checked.promise);
    const reserve = vi.spyOn(t.store, 'reserveOrdinaryTurn').mockReturnValue(reserved.promise);
    t.push({ type: 'child_final', text: 'こんにちは' });
    t.push(petAudio(1));
    t.push({ type: 'pet_final', text: 'こんにちは' });
    await t.settle();
    expect(reserve).not.toHaveBeenCalled();
    checked.resolve(clearCheck());
    await t.settle();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(t.audioOut()).toEqual([]);
    expect(t.store.pet).toEqual([]);
    expect(t.session.canExecuteTools).toBe(false);
    reserved.resolve(true);
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([1]);
    expect(t.session.canExecuteTools).toBe(true);
    await t.session.stop();
    expect(t.store.pet).toEqual(['こんにちは']);
  });

  it('deduplicates repeated finals without charging a genuinely new identical utterance for free', async () => {
    const t = await setup();
    const reserved = deferred<boolean>();
    const reserve = vi.spyOn(t.store, 'reserveOrdinaryTurn').mockReturnValue(reserved.promise);
    t.push({ type: 'child_final', text: 'こんにちは' });
    t.push({ type: 'child_final', text: 'こんにちは' });
    await t.settle();
    expect(reserve).toHaveBeenCalledTimes(1);
    reserved.resolve(true);
    await t.settle();
    t.push({ type: 'child_final', text: 'こんにちは' });
    await t.settle();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(t.store.child).toHaveLength(1);
    t.speak();
    t.quiet();
    t.push({ type: 'child_final', text: 'こんにちは' });
    await t.settle();
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(new Set(reserve.mock.calls.map(([id]) => id)).size).toBe(2);
    await t.session.stop();
  });

  it('uses distinct operation IDs when the same persistent session reconnects', async () => {
    const first = await setup();
    const second = await setup();
    const a = vi.spyOn(first.store, 'reserveOrdinaryTurn');
    const b = vi.spyOn(second.store, 'reserveOrdinaryTurn');
    first.push({ type: 'child_final', text: 'こんにちは' });
    second.push({ type: 'child_final', text: 'こんにちは' });
    await first.settle();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]![0]).not.toBe(b.mock.calls[0]![0]);
    await first.session.stop();
    await second.session.stop();
  });

  it.each(['exhausted', 'unavailable'])(
    'keeps help and crisis screening accessible when quota is %s',
    async (mode) => {
      const t = await setup();
      const reserve = vi.spyOn(t.store, 'reserveOrdinaryTurn');
      if (mode === 'exhausted') reserve.mockResolvedValue(false);
      else reserve.mockRejectedValue(new Error(SENTINEL));
      t.push({ type: 'child_final', text: 'こんにちは' });
      t.push(petAudio(1));
      t.push({ type: 'pet_final', text: 'ORDINARY_REPLY' });
      await t.settle();
      t.push({ type: 'turn_complete' });
      t.push(petAudio(2));
      t.session.onPetAction({ type: 'suggest_game', game: 'story' });
      await t.settle();
      expect(t.audioOut()).toEqual([]);
      expect(t.store.pet).toEqual([]);
      expect(t.session.canExecuteTools).toBe(false);
      expect(t.messages()).toContainEqual({ type: 'pet_transcript', text: 'SAFE' });
      expect(t.messages()).toContainEqual({
        type: 'action',
        action: { type: 'show_help_resources' },
      });
      expect(
        t.messages().some((m) => m.type === 'pet_transcript' && m.text === 'ORDINARY_REPLY'),
      ).toBe(false);
      expect(
        t.messages().some((m) => m.type === 'action' && m.action.type === 'suggest_game'),
      ).toBe(false);
      expect(t.store.crises).toEqual([]);
      expect(t.session.isEnded).toBe(false);
      const helpCount = t.messages().filter((m) => m.type === 'action').length;
      t.session.onPetAction({ type: 'show_help_resources' });
      expect(t.messages().filter((m) => m.type === 'action')).toHaveLength(helpCount + 1);

      t.push({ type: 'child_partial', text: 'もう' });
      t.push({ type: 'child_final', text: 'もう死にたい' });
      await t.running;
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(t.store.crises).toHaveLength(1);
      expect(t.messages()).toContainEqual({ type: 'crisis', message: 'CRISIS', resources: [] });
      expect(t.audioOut()).toEqual([]);
      expect(t.logs.join('\n')).not.toContain(SENTINEL);
    },
  );

  it('does not reserve quota for a crisis and still permits agent escalation after denial', async () => {
    const t = await setup();
    const reserve = vi.spyOn(t.store, 'reserveOrdinaryTurn').mockResolvedValue(false);
    t.push({ type: 'child_final', text: 'もう死にたい' });
    await t.running;
    expect(reserve).not.toHaveBeenCalled();
    expect(t.store.crises).toHaveLength(1);
    const other = await setup();
    vi.spyOn(other.store, 'reserveOrdinaryTurn').mockResolvedValue(false);
    other.push({ type: 'child_final', text: 'こんにちは' });
    await other.settle();
    await other.session.escalate('violence');
    await other.running;
    expect(other.store.crises).toHaveLength(1);
  });

  it.each([true, false])(
    'an older quota decision (%s) cannot mute or authorize a newer utterance',
    async (allowed) => {
      const t = await setup();
      const first = deferred<boolean>();
      const second = deferred<boolean>();
      vi.spyOn(t.store, 'reserveOrdinaryTurn')
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      t.push({ type: 'child_final', text: 'ひとつめ' });
      await t.settle();
      t.push({ type: 'child_final', text: 'ふたつめ' });
      t.push(petAudio(2));
      await t.settle();
      first.resolve(allowed);
      await t.settle();
      expect(t.audioOut()).toEqual([]);
      expect(t.messages().some((m) => m.type === 'action')).toBe(false);
      second.resolve(true);
      await t.settle();
      expect(t.audioOut().map((b) => b[0])).toEqual([2]);
      await t.session.stop();
    },
  );

  it('does not release output when consent is revoked during reservation', async () => {
    const t = await setup();
    const reserved = deferred<boolean>();
    const reserve = vi.spyOn(t.store, 'reserveOrdinaryTurn').mockReturnValue(reserved.promise);
    t.push({ type: 'child_final', text: 'こんにちは' });
    t.push(petAudio(1));
    t.push({ type: 'pet_final', text: 'PENDING_REPLY' });
    await t.settle();
    expect(reserve).toHaveBeenCalledTimes(1);
    const revoking = t.session.revoke();
    reserved.resolve(true);
    await revoking;
    expect(t.audioOut()).toEqual([]);
    expect(t.store.pet).toEqual([]);
    expect(t.session.canExecuteTools).toBe(false);
    expect(t.messages().some((m) => m.type === 'pet_transcript')).toBe(false);
  });

  it('a pending reservation cannot release output after a later crisis', async () => {
    const t = await setup();
    const reserved = deferred<boolean>();
    vi.spyOn(t.store, 'reserveOrdinaryTurn').mockReturnValue(reserved.promise);
    t.push({ type: 'child_final', text: 'こんにちは' });
    t.push(petAudio(1));
    await t.settle();
    t.push({ type: 'child_final', text: 'もう死にたい' });
    await t.settle();
    reserved.resolve(true);
    await t.running;
    expect(t.audioOut()).toEqual([]);
    expect(t.messages()).toContainEqual({ type: 'crisis', message: 'CRISIS', resources: [] });
  });

  it('holds pet audio until the final transcript passes, then releases it in order', async () => {
    const t = await setup();
    t.speak();
    expect(t.live.audio).toHaveLength(15);
    t.push({ type: 'child_partial', text: 'きょうは' });
    t.push(petAudio(1));
    t.push({ type: 'pet_partial', text: 'そうなんだ' });
    t.push(petAudio(2));
    await t.settle();
    expect(t.audioOut()).toHaveLength(0);
    t.quiet();
    t.push({ type: 'child_final', text: `きょうは${SENTINEL}` });
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([1, 2]);
    expect(t.messages()).toContainEqual({ type: 'pet_transcript', text: 'そうなんだ' });
    t.push(petAudio(3));
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([1, 2, 3]);

    expect(t.store.child).toHaveLength(1);
    expect(t.store.child[0]!.check.hit).toBe(false);
    expect(t.store.features[0]!.messageId).toBe('m1');
    expect(t.store.features[0]!.f.durationMs).toBe(600);
    expect(t.store.features[0]!.f.speechRate).toBeGreaterThan(0);
    expect(t.published).toEqual([
      {
        topic: 'message.created',
        payload: {
          familyId: 'f1',
          childId: 'c1',
          sessionId: 's1',
          messageId: 'm1',
          channel: 'voice',
        },
      },
    ]);
    t.push({ type: 'pet_final', text: 'そうなんだ' });
    await t.settle();
    await t.session.stop();
    expect(t.store.pet).toEqual(['そうなんだ']);
    expect(t.messages().at(-1)).toEqual({ type: 'end', reason: 'stop' });
    expect(t.live.closed).toBe(true);
    expect(t.socketClosed()).toBe(true);
    expect(t.store.ended).toBe(true);
    expect(t.logs.join('\n')).not.toContain(SENTINEL);
  });

  it('crisis in the child transcript: zero pet audio, crisis copy, crisis event and publish', async () => {
    const t = await setup();
    t.speak();
    t.push({ type: 'child_partial', text: 'もう' });
    t.push(petAudio(1));
    t.quiet();
    t.push({ type: 'child_final', text: 'もう死にたい' });
    await t.settle();
    t.push(petAudio(2));
    await t.settle();

    expect(t.audioOut()).toHaveLength(0);
    const msgs = t.messages();
    expect(msgs.filter((m) => m.type === 'crisis')).toEqual([
      { type: 'crisis', message: 'CRISIS', resources: [] },
    ]);
    expect(msgs.at(-1)).toEqual({ type: 'end', reason: 'crisis' });
    expect(msgs.some((m) => m.type === 'pet_transcript')).toBe(false);
    await t.running;
    expect(t.live.closed).toBe(true);
    expect(t.store.safeMode).toBe(true);
    expect(t.store.crises).toEqual([
      { messageId: 'm1', check: expect.objectContaining({ hit: true }) },
    ]);
    expect(t.published.map((p) => p.topic)).toEqual(['message.created', 'crisis.detected']);
    expect(t.published[1]!.payload).toEqual({
      childId: 'c1',
      crisisId: 'k1',
      category: 'other',
      familyHarmSuspected: false,
    });
    expect(t.logs.join('\n')).not.toContain('死にたい');
  });

  it('escalate_crisis from the pet cuts the stream mid-speech', async () => {
    const t = await setup();
    t.speak();
    t.quiet();
    t.push({ type: 'child_final', text: 'ねえきいて' });
    await t.settle();
    t.push(petAudio(1));
    await t.settle();
    expect(t.audioOut()).toHaveLength(1);
    const res = await t.session.escalate('extortion');
    expect(res.crisisId).toBe('k1');
    t.push(petAudio(2));
    await t.settle();
    expect(t.audioOut()).toHaveLength(1);
    expect(t.store.crises).toEqual([
      {
        agentCategory: 'extortion',
        routing: { category: 'extortion', familyHarmSuspected: false },
      },
    ]);
    expect(t.published.at(-1)!.topic).toBe('crisis.detected');
    expect(t.messages().at(-1)).toEqual({ type: 'end', reason: 'crisis' });
  });

  it('defers release while the child is still talking after a final transcript', async () => {
    const t = await setup();
    t.speak();
    t.push(petAudio(1));
    t.push({ type: 'child_final', text: 'あのね' });
    await t.settle();
    expect(t.audioOut()).toHaveLength(0);
    t.quiet();
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([1]);
  });

  it('pet audio after the next utterance starts stays held until that utterance is final', async () => {
    const t = await setup();
    t.speak();
    t.quiet();
    t.push({ type: 'child_partial', text: 'つぎの' });
    t.push(petAudio(1));
    await t.settle();
    t.push({ type: 'child_final', text: 'さっきの' });
    t.push({ type: 'child_partial', text: 'つぎの' });
    t.push(petAudio(2));
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([]);
    t.push({ type: 'child_final', text: 'つぎのはなし' });
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([2]);
    await t.session.stop();
  });

  it('output filter hit interrupts the turn and shows the safe reply instead', async () => {
    const t = await setup();
    t.speak();
    t.quiet();
    t.push({ type: 'child_final', text: 'きみはだれ' });
    await t.settle();
    t.push(petAudio(1));
    t.push({ type: 'pet_partial', text: 'ぼくは人間だよ' });
    t.push(petAudio(2));
    t.push({ type: 'pet_final', text: 'ぼくは人間だよ' });
    t.push({ type: 'turn_complete' });
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([1]);
    const msgs = t.messages();
    expect(msgs).toContainEqual({ type: 'interrupted' });
    expect(msgs).toContainEqual({ type: 'pet_transcript', text: 'SAFE' });
    expect(msgs.some((m) => m.type === 'pet_transcript' && m.text.includes('人間'))).toBe(false);
    await t.session.stop();
    expect(t.store.pet).toEqual(['SAFE']);
  });

  it('missing final transcript: held audio is dropped and the child is asked again', async () => {
    const t = await setup({ transcriptTimeoutMs: 30 });
    t.speak();
    t.push(petAudio(1));
    t.quiet();
    await new Promise((r) => setTimeout(r, 80));
    expect(t.audioOut()).toHaveLength(0);
    expect(t.messages()).toContainEqual({ type: 'pet_transcript', text: 'RETRY' });
    t.push({ type: 'child_final', text: 'おそくなった' });
    t.push({ type: 'turn_complete' });
    t.push(petAudio(2));
    await t.settle();
    expect(t.audioOut()).toHaveLength(0);
    expect(t.session.canExecuteTools).toBe(false);
    t.speak();
    t.quiet();
    t.push({ type: 'child_final', text: 'あらためて' });
    t.push(petAudio(3));
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([3]);
    await t.session.stop();
  });

  it('noise with no pet output times out silently', async () => {
    const t = await setup({ transcriptTimeoutMs: 30 });
    t.speak(10);
    t.quiet();
    await new Promise((r) => setTimeout(r, 80));
    expect(t.out).toHaveLength(0);
    await t.session.stop();
  });

  it('waits for semantic clearance even when no keyword matches', async () => {
    const t = await setup();
    const check = deferred<CrisisCheck>();
    vi.spyOn(t.detector, 'check').mockReturnValue(check.promise);
    t.push({ type: 'child_final', text: 'きいてほしい' });
    t.push(petAudio(1));
    await t.settle();
    expect(t.audioOut()).toEqual([]);
    expect(t.session.canExecuteTools).toBe(false);
    check.resolve(clearCheck());
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([1]);
    expect(t.session.canExecuteTools).toBe(true);
    const checkedTurn = t.session.toolTurnId;
    t.push({ type: 'child_partial', text: 'つぎは' });
    await t.settle();
    expect(t.session.toolTurnId).not.toBe(checkedTurn);
    expect(t.session.canExecuteTools).toBe(false);
    await t.session.stop();
  });

  it('filters an unsafe suffix that appears only in the final pet transcript', async () => {
    const t = await setup();
    t.push({ type: 'child_final', text: 'きみはだれ' });
    await t.settle();
    t.push({ type: 'pet_partial', text: 'こんにちは。' });
    t.push({ type: 'pet_final', text: 'こんにちは。ぼくは人間だよ' });
    t.push(petAudio(3));
    await t.settle();
    await t.session.stop();
    expect(t.audioOut()).toEqual([]);
    expect(t.messages()).toContainEqual({ type: 'pet_transcript', text: 'SAFE' });
    expect(t.store.pet).toEqual(['SAFE']);
  });

  it('stale clear cannot authorize audio or tools in a newer utterance', async () => {
    const t = await setup();
    const first = deferred<CrisisCheck>();
    const second = deferred<CrisisCheck>();
    vi.spyOn(t.detector, 'check')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    t.push({ type: 'child_final', text: 'ひとつめ' });
    await t.settle();
    t.push({ type: 'child_partial', text: 'ふたつめ' });
    t.push(petAudio(2));
    first.resolve(clearCheck());
    await t.settle();
    expect(t.audioOut()).toEqual([]);
    expect(t.session.canExecuteTools).toBe(false);
    t.push({ type: 'child_final', text: 'ふたつめ' });
    await t.settle();
    second.resolve(clearCheck());
    await t.settle();
    expect(t.audioOut().map((b) => b[0])).toEqual([2]);
    await t.session.stop();
  });

  it('a late hit interrupts even after a newer clear has released audio', async () => {
    const t = await setup();
    const old = deferred<CrisisCheck>();
    vi.spyOn(t.detector, 'check').mockReturnValueOnce(old.promise).mockResolvedValue(clearCheck());
    t.push({ type: 'child_final', text: 'ひとつめ' });
    await t.settle();
    t.push({ type: 'child_final', text: 'ふたつめ' });
    await t.settle();
    t.push(petAudio(2));
    await t.settle();
    old.resolve({ ...clearCheck(), hit: true, category: 'family_harm', familyHarmSuspected: true });
    await t.settle();
    t.push(petAudio(3));
    await t.session.stop();
    expect(t.audioOut().map((b) => b[0])).toEqual([2]);
    expect(t.store.crises).toHaveLength(1);
    expect(t.published.at(-1)?.payload['familyHarmSuspected']).toBe(true);
  });

  it('detector rejection pauses an unmatched utterance without leaking exception text', async () => {
    const t = await setup();
    vi.spyOn(t.detector, 'check').mockRejectedValue(new Error(SENTINEL));
    t.push({ type: 'child_final', text: SENTINEL });
    t.push(petAudio(1));
    await t.settle();
    await t.session.stop();
    expect(t.audioOut()).toEqual([]);
    expect(t.store.child[0]?.check).toMatchObject({
      hit: false,
      method: 'paused',
      availability: 'unavailable',
    });
    expect(t.messages()).toContainEqual({ type: 'pet_transcript', text: 'PAUSED' });
    expect(t.store.crises).toEqual([]);
    expect(t.logs.join('\n')).not.toContain(SENTINEL);
  });

  it('detector rejection on a keyword hit still enters the crisis path', async () => {
    const t = await setup();
    vi.spyOn(t.detector, 'check').mockRejectedValue(new Error('boom'));
    t.push({ type: 'child_final', text: 'もう死にたい' });
    await t.settle();
    await t.session.stop();
    expect(t.store.child[0]?.check).toMatchObject({ hit: true, category: 'other' });
    expect(t.messages()).toContainEqual({ type: 'crisis', message: 'CRISIS', resources: [] });
  });

  it('a paused utterance: held pet audio dropped, fixed line and help shown, recheck queued, no turn charged', async () => {
    const t = await setup();
    const reserve = vi.spyOn(t.store, 'reserveOrdinaryTurn');
    vi.spyOn(t.detector, 'check').mockResolvedValue({
      ...clearCheck(),
      availability: 'unavailable',
      method: 'paused',
    });
    t.push({ type: 'child_final', text: SENTINEL });
    t.push(petAudio(1));
    t.push({ type: 'pet_final', text: 'HELD' });
    await t.settle();
    t.push(petAudio(2));
    await t.settle();
    await t.session.stop();
    expect(t.audioOut()).toEqual([]);
    expect(t.store.pet).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    expect(t.messages()).toEqual(
      expect.arrayContaining([
        { type: 'interrupted' },
        { type: 'action', action: { type: 'set_expression', expression: 'sleepy' } },
        { type: 'pet_transcript', text: 'PAUSED' },
        { type: 'action', action: { type: 'show_help_resources' } },
      ]),
    );
    expect(t.rechecks).toEqual([
      { familyId: 'f1', childId: 'c1', sessionId: 's1', messageId: 'm1', channel: 'voice' },
    ]);
    expect(t.published.map((p) => p.topic)).not.toContain('message.created');
    expect(t.logs.join('\n')).not.toContain(SENTINEL);
  });

  it('agent escalation without a current check routes by the agent category', async () => {
    const t = await setup();
    expect(t.session.canExecuteTools).toBe(false);
    await t.session.escalate('violence');
    await t.session.stop();
    expect(t.store.crises).toEqual([
      { agentCategory: 'violence', routing: { category: 'violence', familyHarmSuspected: false } },
    ]);
    expect(t.published.at(-1)?.payload).toMatchObject({
      category: 'violence',
      familyHarmSuspected: false,
    });
    expect(t.messages()).toContainEqual({
      type: 'crisis',
      message: 'CRISIS',
      resources: [],
    });
  });

  it('a live error ends the session with reason error', async () => {
    const t = await setup();
    vi.spyOn(t.store, 'end').mockRejectedValue(new Error(SENTINEL));
    t.push({ type: 'error', code: SENTINEL });
    await t.running;
    expect(t.store.end).toHaveBeenCalled();
    expect(t.messages()).toEqual([{ type: 'end', reason: 'error' }]);
    expect(t.logs.join('\n')).not.toContain(SENTINEL);
    expect(t.logs.join('\n')).toContain('live_stream_failed');
    expect(t.logs.join('\n')).toContain('operation_failed');
  });

  it('redacts persistence failures containing child text', async () => {
    const t = await setup();
    vi.spyOn(t.store, 'writeChildTranscript').mockRejectedValue(new Error(SENTINEL));
    t.push({ type: 'child_final', text: 'こんにちは' });
    await t.settle();
    await t.session.stop();
    expect(t.logs.join('\n')).toContain('voice.persist_failed');
    expect(t.logs.join('\n')).not.toContain(SENTINEL);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function clearCheck(): CrisisCheck {
  return {
    hit: false,
    category: 'none',
    familyHarmSuspected: false,
    method: 'none',
    keywordMatched: false,
    confidence: 0,
    latencyMs: 0,
    availability: 'verified',
  };
}
