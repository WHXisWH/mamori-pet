import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Firestore, Timestamp } from '@google-cloud/firestore';
import { DevChildDirectory } from '@ijime/agent-core';
import type { VoiceServerMessage } from '@ijime/api-types';
import type { CrisisCheck } from '@ijime/crisis-detector';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { createVoiceBackend } from '../src/backend.js';
import { createVoiceRuntime } from '../src/runtime.js';
import { attachVoiceServer } from '../src/server.js';
import { FakeLiveLlm, until } from './fake-live.js';

let db: Firestore;
let kb: Kb;
let sequence = 0;
const CLEAR: CrisisCheck = {
  hit: false,
  category: 'none',
  familyHarmSuspected: false,
  method: 'none',
  keywordMatched: false,
  confidence: 0,
  latencyMs: 0,
};

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-revoke-${Date.now()}` });
  kb = await Kb.load(
    new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
  );
});
afterAll(() => db.terminate());

async function setup(holdOpening = false) {
  const child = (await new DevChildDirectory(db).lookup(`c_revoke_${sequence++}`))!;
  const root = db.doc(`families/${child.familyId}/children/${child.childId}`);
  const llm = new FakeLiveLlm();
  const opening = deferred<void>();
  const out: (VoiceServerMessage | Buffer)[] = [];
  const published: string[] = [];
  const io = {
    send: (event: VoiceServerMessage | Buffer) => out.push(event),
    closeSocket: vi.fn(),
  };
  const deps = await createVoiceRuntime({
    db,
    kb,
    logger: new Logger('voice-relay', () => {}),
    createModel: () => ({
      model: llm,
      connected: holdOpening
        ? Promise.all([llm.connected, opening.promise]).then(() => undefined)
        : llm.connected,
    }),
    publish: async (topic) => {
      published.push(topic);
    },
    callTool: async (name) =>
      name === 'get_child_context'
        ? {
            gradeBand: 'high',
            characterId: 'moko',
            localTime: '',
            dayType: 'school_day',
            recentTrend: '',
            careFlag: false,
          }
        : { memories: ['OLD_PRIVATE_MEMORY'] },
  });
  return { child, root, llm, io, out, deps, published, opening, backend: createVoiceBackend(deps) };
}

describe('active voice authorization', () => {
  it.each(['deleting', 'paused', 'voice', 'memory', 'history', 'missing'])(
    'revokes %s and drops pending input and old Live context',
    async (change) => {
      const t = await setup();
      const checked = deferred<CrisisCheck>();
      const check = vi.spyOn(t.deps.detector, 'check').mockReturnValue(checked.promise);
      const opened = await t.backend.open(t.child, {}, t.io);
      const running = opened.session.attach(opened.live);
      const conn = t.llm.connections[0]!;
      if (change === 'memory') {
        conn.server.push({
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'old-recall', name: 'recall', args: { topic: 'old' } } }],
          },
        });
        await until(() => JSON.stringify(conn.contents).includes('OLD_PRIVATE_MEMORY'));
      }
      conn.server.push({ inputTranscription: { text: 'pending private input', finished: true } });
      await until(() => check.mock.calls.length === 1);
      if (change === 'missing') await t.root.delete();
      else
        await t.root.update(
          change === 'voice'
            ? { 'dataSources.voice': false }
            : change === 'memory'
              ? { memoryRevision: 1 }
              : change === 'history'
                ? { modelHistoryResetAt: Timestamp.now() }
                : { status: change },
        );
      await until(() => opened.session.isEnded);
      const beforeAudio = conn.realtime.length;
      opened.session.onAudio(Buffer.alloc(1280));
      checked.resolve(CLEAR);
      await running;
      expect(conn.closed).toBe(true);
      expect(conn.realtime).toHaveLength(beforeAudio);
      expect(opened.session.canExecuteTools).toBe(false);
      expect(t.out.filter(Buffer.isBuffer)).toEqual([]);
      expect(t.published).toEqual([]);
      const saved = await t.root.collection(`sessions/${opened.sessionId}/messages`).get();
      expect(saved.docs.filter((doc) => doc.get('inputMode') === 'voice_transcript')).toEqual([]);
      expect(
        (await t.root.collection(`sessions/${opened.sessionId}/voiceFeatures`).get()).empty,
      ).toBe(true);
      expect(t.io.closeSocket).toHaveBeenCalled();
    },
  );

  it('does not complete opening after consent is revoked during model connection', async () => {
    const t = await setup(true);
    const server = createServer();
    const voice = attachVoiceServer(server, {
      backend: { ...t.backend, redeem: async () => t.child },
      logger: new Logger('voice-relay', () => {}),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const messages: VoiceServerMessage[] = [];
    try {
      const ws = new WebSocket(
        `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/voice?ticket=test`,
      );
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      ws.on('message', (data) => messages.push(JSON.parse(String(data)) as VoiceServerMessage));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      ws.send(JSON.stringify({ type: 'start', sampleRateHz: 16000 }));
      await until(() => t.llm.connections.length === 1);
      await t.root.update({ 'dataSources.voice': false });
      await closed;
      await until(() => t.llm.connections[0]!.closed);
      expect(messages.some((event) => event.type === 'ready')).toBe(false);
      expect(messages.some((event) => event.type === 'end')).toBe(true);
    } finally {
      t.opening.resolve();
      await voice.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
