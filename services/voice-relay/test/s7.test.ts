// S7 音声での危機：偽の Live ランナー + 本物の WebSocket クライアント + Firestore エミュレーター。続けて notifier に渡して S1 を通す
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory, ScriptedLlm } from '@ijime/agent-core';
import type { VoiceServerMessage } from '@ijime/api-types';
import { agent } from '@ijime/config';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { createApp as createNotifier } from '@ijime/notifier/src/app.js';
import { LogOnlySender, MemorySender } from '@ijime/notifier/src/channels.js';
import { crisisNotificationId } from '@ijime/notifier/src/crisis.js';
import {
  encodePushEnvelope,
  Logger,
  MemoryTaskQueue,
  tokenDigest,
  VOICE_TICKETS,
} from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createVoiceBackend } from '../src/backend.js';
import { createVoiceRuntime } from '../src/runtime.js';
import { attachVoiceServer } from '../src/server.js';
import { FakeLiveLlm, until } from './fake-live.js';
import { MemoryDailyFeatures } from '@ijime/notifier/src/weekly-source.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');

let db: Firestore;
let kb: Kb;
let server: Server;
let port: number;
let closeAll: () => Promise<void>;
const models: FakeLiveLlm[] = [];
const published: { topic: string; payload: Record<string, unknown> }[] = [];
const toolCalls: string[] = [];
const logs: string[] = [];
let hangNext = false;

const eventsFor = (childId: string) => published.filter((p) => p.payload['childId'] === childId);
const endedSession = (sessionId: string) =>
  logs.some((line) => {
    const entry = JSON.parse(line) as Record<string, unknown>;
    return entry['event'] === 'voice.session_end' && entry['sessionId'] === sessionId;
  });

function tone(frames: number): Buffer {
  const n = frames * 640;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++)
    b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 200 * i) / 16000)), i * 2);
  return b;
}
const silence = (frames: number) => Buffer.alloc(frames * 1280);

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-voice-${Date.now()}` });
  kb = await Kb.load(new FsKbSource(KB_DIR));
  const deps = await createVoiceRuntime({
    db,
    kb,
    logger: new Logger('voice-relay', (l) => logs.push(l)),
    publish: async (topic, payload) => {
      published.push({ topic, payload });
    },
    callTool: async (name) => {
      toolCalls.push(name);
      if (name === 'get_child_context')
        return {
          gradeBand: 'high',
          characterId: 'moko',
          localTime: '2026/10/01 16:00',
          dayType: 'school_day',
          recentTrend: '',
          careFlag: false,
        };
      if (name === 'recall') return { memories: [] };
      return { ok: true };
    },
    createModel: () => {
      const llm = new FakeLiveLlm(hangNext);
      models.push(llm);
      return { model: llm, connected: llm.connected };
    },
  });
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  closeAll = attachVoiceServer(server, {
    backend: createVoiceBackend(deps),
    logger: new Logger('voice-relay', (l) => logs.push(l)),
  }).closeAll;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await closeAll();
  await new Promise((r) => server.close(r));
  await db.terminate();
});

async function issueTicket(childId: string): Promise<{ ticket: string; familyId: string }> {
  const child = (await new DevChildDirectory(db).lookup(childId))!;
  const ticket = `tk_${childId}_${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  await db
    .collection(VOICE_TICKETS)
    .doc(tokenDigest(ticket))
    .set({
      childId,
      familyId: child.familyId,
      createdAt: new Date(now),
      expiresAt: new Date(now + 60_000),
    });
  return { ticket, familyId: child.familyId };
}

type Client = {
  ws: WebSocket;
  messages: VoiceServerMessage[];
  audioBytes: () => number;
  send: (m: unknown) => void;
  closed: Promise<void>;
};

function connect(ticket: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/v1/voice?ticket=${encodeURIComponent(ticket)}`,
    );
    const messages: VoiceServerMessage[] = [];
    let audio = 0;
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.on('message', (data, isBinary) => {
      if (isBinary) audio += (data as Buffer).length;
      else messages.push(JSON.parse(String(data)) as VoiceServerMessage);
    });
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        audioBytes: () => audio,
        send: (m) => ws.send(Buffer.isBuffer(m) ? m : JSON.stringify(m)),
        closed,
      }),
    );
    ws.on('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    ws.on('error', reject);
  });
}

async function start(
  c: Client,
  sessionId?: string,
): Promise<{ sessionId: string; llm: FakeLiveLlm }> {
  const before = models.length;
  c.send({ type: 'start', sampleRateHz: 16000, ...(sessionId ? { sessionId } : {}) });
  await until(() => c.messages.some((m) => m.type === 'ready' || m.type === 'end'));
  const ready = c.messages.find((m) => m.type === 'ready');
  if (!ready || ready.type !== 'ready') throw new Error('not ready');
  return { sessionId: ready.sessionId, llm: models[before]! };
}

const audioPart = (n: number) => ({
  content: {
    role: 'model',
    parts: [
      {
        inlineData: {
          mimeType: 'audio/pcm;rate=24000',
          data: Buffer.alloc(n, 1).toString('base64'),
        },
      },
    ],
  },
  partial: true,
});

describe('S7 voice crisis', () => {
  it('keeps crisis speech accessible at the shared daily limit without ordinary output', async () => {
    const childId = 'c_s7_quota_crisis';
    const { ticket, familyId } = await issueTicket(childId);
    const base = `families/${familyId}/children/${childId}`;
    const date = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const usage = db.doc(`${base}/chatUsage/${date}`);
    await usage.set({ turns: agent.dailyTurnLimit });
    const c = await connect(ticket);
    const { sessionId, llm } = await start(c);
    const conn = llm.connections[0]!;
    conn.server.push({ inputTranscription: { text: 'こんにちは', finished: true } });
    conn.server.push(audioPart(4800));
    conn.server.push({ outputTranscription: { text: 'ORDINARY_REPLY', finished: true } });
    conn.server.push({ turnComplete: true });
    await until(() =>
      c.messages.some((m) => m.type === 'action' && m.action.type === 'show_help_resources'),
    );
    expect(c.audioBytes()).toBe(0);
    expect(c.messages.some((m) => m.type === 'pet_transcript' && m.text === 'ORDINARY_REPLY')).toBe(
      false,
    );
    expect(c.messages.some((m) => m.type === 'crisis' || m.type === 'end')).toBe(false);

    conn.server.push({ inputTranscription: { text: 'もう', finished: false }, partial: true });
    conn.server.push({ inputTranscription: { text: 'もう死にたい', finished: true } });
    conn.server.push(audioPart(4800));
    await c.closed;
    await vi.waitFor(async () =>
      expect((await db.collection(`${base}/crisisEvents`).get()).size).toBe(1),
    );
    expect(c.messages).toContainEqual({ type: 'end', reason: 'crisis' });
    expect(c.messages.some((m) => m.type === 'crisis')).toBe(true);
    expect(c.audioBytes()).toBe(0);
    expect((await usage.get()).get('turns')).toBe(agent.dailyTurnLimit);
    const messages = await db.collection(`${base}/sessions/${sessionId}/messages`).get();
    expect(messages.docs.some((d) => d.get('role') === 'pet')).toBe(false);
  });

  it('charges duplicate finals once and keeps the child budget across a WebSocket reconnect', async () => {
    const childId = 'c_s7_quota_reconnect';
    const { ticket, familyId } = await issueTicket(childId);
    const base = `families/${familyId}/children/${childId}`;
    const date = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const usage = db.doc(`${base}/chatUsage/${date}`);
    await usage.set({ turns: agent.dailyTurnLimit - 1 });
    const c = await connect(ticket);
    const { sessionId, llm } = await start(c);
    const conn = llm.connections[0]!;
    conn.server.push({ inputTranscription: { text: 'こんにちは', finished: true } });
    conn.server.push({ inputTranscription: { text: 'こんにちは', finished: true } });
    conn.server.push(audioPart(4800));
    await until(() => c.audioBytes() === 4800);
    expect(c.messages.filter((m) => m.type === 'child_transcript')).toHaveLength(1);
    c.send({ type: 'stop' });
    await c.closed;
    await until(() => endedSession(sessionId));
    const nextTicket = await issueTicket(childId);
    const next = await connect(nextTicket.ticket);
    const resumed = await start(next, sessionId);
    expect(resumed.sessionId).not.toBe(sessionId);
    const nextConn = resumed.llm.connections[0]!;
    nextConn.server.push({ inputTranscription: { text: 'こんにちは', finished: true } });
    nextConn.server.push(audioPart(4800));
    await until(() =>
      next.messages.some((m) => m.type === 'action' && m.action.type === 'show_help_resources'),
    );
    expect(next.audioBytes()).toBe(0);
    expect((await usage.get()).get('turns')).toBe(agent.dailyTurnLimit);
    next.send({ type: 'stop' });
    await next.closed;
  });

  it('crisis speech: 0 bytes of pet audio, crisis copy, crisisEvents, then S1 notification', async () => {
    const childId = 'c_s7';
    const { ticket, familyId } = await issueTicket(childId);
    const base = `families/${familyId}/children/${childId}`;
    await db.doc(`families/${familyId}`).set({ familyId, status: 'active' });
    await db.doc(base).set({ nickname: 'はな' }, { merge: true });
    await db.doc(`families/${familyId}/guardians/g1`).set({
      guardianId: 'g1',
      role: 'primary',
      email: 'a@example.com',
      notifyChannels: ['webpush'],
    });
    await db
      .doc(`families/${familyId}/devices/d1`)
      .set({ ownerType: 'guardian', ownerId: 'g1', fcmToken: 'tok', lastSeenAt: new Date() });

    const c = await connect(ticket);
    const { sessionId, llm } = await start(c);
    expect(toolCalls).toContain('get_child_context');
    const conn = llm.connections[0]!;
    expect(conn.request.liveConnectConfig?.inputAudioTranscription).toEqual({});
    expect(JSON.stringify(conn.request.config?.systemInstruction)).toContain('音声での話し方');

    c.send(tone(15));
    await until(() => conn.realtime.length >= 15);
    conn.server.push({ inputTranscription: { text: 'もう', finished: false }, partial: true });
    conn.server.push(audioPart(4800));
    c.send(silence(20));
    await until(() => conn.realtime.length >= 35);
    conn.server.push({ inputTranscription: { text: 'もう死にたい', finished: true } });
    conn.server.push(audioPart(4800));
    await c.closed;

    expect(c.audioBytes()).toBe(0);
    const types = c.messages.map((m) => m.type);
    expect(types).toEqual(['ready', 'child_transcript', 'child_transcript', 'crisis', 'end']);
    const crisis = c.messages[3] as Extract<VoiceServerMessage, { type: 'crisis' }>;
    expect(crisis.resources.map((r) => r.id).sort()).toEqual([
      'childline',
      'emergency',
      'sos_dial',
    ]);
    expect(c.messages[4]).toEqual({ type: 'end', reason: 'crisis' });
    await until(() => conn.closed);

    await until(() => eventsFor(childId).some((p) => p.topic === 'crisis.detected'));
    const msgs = await db.collection(`${base}/sessions/${sessionId}/messages`).get();
    expect(msgs.size).toBe(1);
    const m = msgs.docs[0]!.data();
    expect(m['role']).toBe('child');
    expect(m['inputMode']).toBe('voice_transcript');
    expect(m['crisisCheck']).toMatchObject({ hit: true });
    expect(Buffer.from(m['contentEnc']).toString('utf8')).not.toContain('死にたい');
    const vf = await db.collection(`${base}/sessions/${sessionId}/voiceFeatures`).get();
    expect(vf.docs[0]!.data()).toMatchObject({ messageId: msgs.docs[0]!.id, durationMs: 600 });

    const crises = await db.collection(`${base}/crisisEvents`).get();
    expect(crises.size).toBe(1);
    const k = crises.docs[0]!;
    expect(k.data()).toMatchObject({
      triggerType: 'voice',
      sourceRef: `${base}/sessions/${sessionId}/messages/${msgs.docs[0]!.id}`,
      status: 'open',
    });
    const session = (await db.doc(`${base}/sessions/${sessionId}`).get()).data()!;
    expect(session['channel']).toBe('voice');
    expect(session['safeMode']).toBe(true);
    await until(() => endedSession(sessionId));
    expect((await db.doc(`${base}/sessions/${sessionId}`).get()).data()!['endedAt']).toBeDefined();

    const created = eventsFor(childId).find((p) => p.topic === 'message.created')!;
    expect(created.payload).toEqual({
      familyId,
      childId,
      sessionId,
      messageId: msgs.docs[0]!.id,
      channel: 'voice',
    });
    const detected = eventsFor(childId).find((p) => p.topic === 'crisis.detected')!;
    expect(detected.payload).toEqual({
      childId,
      crisisId: k.id,
      category: 'other',
      familyHarmSuspected: false,
    });

    // S1 と同じ：notifier は crisis.detected を受け取ると、保護者あての crisis 通知を登録して送信する
    const nlogs: string[] = [];
    const nlogger = new Logger('notifier', (l) => nlogs.push(l));
    const tasks = new MemoryTaskQueue();
    const webpush = new MemorySender();
    const notifier = createNotifier(
      async () => ({
        db,
        kb,
        model: new ScriptedLlm(() => {
          throw new Error('crisis path must not call the model');
        }),
        tasks,
        senders: {
          webpush,
          email: new LogOnlySender('email', nlogger),
          sms: new LogOnlySender('sms', nlogger),
        },
        logger: nlogger,
        selfUrl: 'http://notifier.test',
        features: new MemoryDailyFeatures(),
        now: () => new Date(),
      }),
      nlogger,
    );
    const post = (path: string, body: unknown) =>
      notifier.request(path, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
    expect(
      (await post('/internal/events/crisis-detected', encodePushEnvelope(detected.payload))).status,
    ).toBe(204);
    const notif = (
      await db
        .doc(`families/${familyId}/notifications/${crisisNotificationId(childId, k.id)}`)
        .get()
    ).data();
    expect(notif).toMatchObject({ kind: 'crisis', level: 'l4', recipientIds: ['g1'] });
    for (const t of tasks.take('notify-send'))
      expect((await post(new URL(t.url).pathname, t.body)).status).toBe(204);
    expect(webpush.sent.map((s) => s.guardianId)).toEqual(['g1']);
    expect(tasks.take('crisis-escalation')).toHaveLength(1);

    expect([...logs, ...nlogs].join('\n')).not.toContain('死にたい');
  });

  it('ordinary speech: audio released after the check, both transcripts stored encrypted', async () => {
    const childId = 'c_s7_ok';
    const { ticket, familyId } = await issueTicket(childId);
    const base = `families/${familyId}/children/${childId}`;
    const c = await connect(ticket);
    const { sessionId, llm } = await start(c);
    const conn = llm.connections[0]!;

    c.send(tone(15));
    await until(() => conn.realtime.length >= 15);
    conn.server.push({ inputTranscription: { text: 'きょう', finished: false }, partial: true });
    conn.server.push(audioPart(4800));
    conn.server.push({
      outputTranscription: { text: 'そうなんだ', finished: false },
      partial: true,
    });
    c.send(silence(20));
    await until(() => conn.realtime.length >= 35);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.audioBytes()).toBe(0);
    conn.server.push({ inputTranscription: { text: 'きょうたのしかった', finished: true } });
    await until(() => c.audioBytes() === 4800);
    conn.server.push({ outputTranscription: { text: 'そうなんだ', finished: true } });
    conn.server.push({ turnComplete: true });
    await until(() => eventsFor(childId).some((p) => p.topic === 'message.created'));
    await vi.waitFor(async () => {
      const transcripts = await db.collection(`${base}/sessions/${sessionId}/messages`).get();
      expect(transcripts.docs.some((doc) => doc.data()['role'] === 'pet')).toBe(true);
    });
    c.send({ type: 'stop' });
    await c.closed;
    await until(() => conn.closed);

    expect(c.messages.map((m) => m.type)).toEqual([
      'ready',
      'child_transcript',
      'child_transcript',
      'pet_transcript',
      'end',
    ]);
    expect(c.messages.at(-1)).toEqual({ type: 'end', reason: 'stop' });
    await until(() => endedSession(sessionId));
    const msgs = await db
      .collection(`${base}/sessions/${sessionId}/messages`)
      .orderBy('createdAt')
      .get();
    expect(msgs.docs.map((d) => [d.data()['role'], d.data()['inputMode']])).toEqual([
      ['child', 'voice_transcript'],
      ['pet', 'voice_transcript'],
    ]);
    for (const d of msgs.docs) expect(Buffer.isBuffer(d.data()['contentEnc'])).toBe(true);
    expect(eventsFor(childId).map((p) => p.topic)).toEqual(['message.created']);
    expect((await db.collection(`${base}/crisisEvents`).get()).size).toBe(0);
    expect(logs.join('\n')).not.toContain('たのしかった');
  });

  it('rejects a used ticket, an unknown ticket and ends with error when Live never connects', async () => {
    const { ticket } = await issueTicket('c_s7_t');
    const c = await connect(ticket);
    await expect(connect(ticket)).rejects.toThrow('http 401');
    await expect(connect('nope')).rejects.toThrow('http 401');
    c.ws.close();
    await c.closed;

    const { ticket: t2 } = await issueTicket('c_s7_hang');
    hangNext = true;
    const c2 = await connect(t2);
    c2.send({ type: 'start', sampleRateHz: 16000 });
    await c2.closed;
    hangNext = false;
    expect(c2.messages).toEqual([{ type: 'end', reason: 'error' }]);
  }, 20_000);

  it('refuses to start when the child turned voice off', async () => {
    const { ticket, familyId } = await issueTicket('c_s7_off');
    await db
      .doc(`families/${familyId}/children/c_s7_off`)
      .set({ dataSources: { voice: false } }, { merge: true });
    const c = await connect(ticket);
    c.send({ type: 'start', sampleRateHz: 16000 });
    await c.closed;
    expect(c.messages).toEqual([{ type: 'end', reason: 'error' }]);
  });

  it.each(['open', 'guardian_acknowledged'])(
    'refuses a fresh voice session while a crisis is %s',
    async (status) => {
      const childId = `c_s7_active_${status}`;
      const { ticket, familyId } = await issueTicket(childId);
      await db.doc(`families/${familyId}/children/${childId}/crisisEvents/k1`).set({ status });
      const before = models.length;
      const c = await connect(ticket);
      c.send({ type: 'start', sampleRateHz: 16000 });
      await c.closed;
      expect(c.messages).toEqual([{ type: 'end', reason: 'error' }]);
      expect(models).toHaveLength(before);
      expect(
        (await db.collection(`families/${familyId}/children/${childId}/sessions`).get()).empty,
      ).toBe(true);
    },
  );

  it('allows a fresh voice session after an explicitly closed crisis', async () => {
    const childId = 'c_s7_closed';
    const { ticket, familyId } = await issueTicket(childId);
    await db
      .doc(`families/${familyId}/children/${childId}/crisisEvents/k1`)
      .set({ status: 'closed' });
    const c = await connect(ticket);
    await start(c);
    c.send({ type: 'stop' });
    await c.closed;
    expect(c.messages.at(-1)).toEqual({ type: 'end', reason: 'stop' });
  });
});
