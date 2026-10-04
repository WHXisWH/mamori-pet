import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory } from '@ijime/agent-core';
import type { ToolCallReq } from '@ijime/api-types';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createVoiceBackend } from '../src/backend.js';
import { createVoiceRuntime } from '../src/runtime.js';
import { FakeLiveLlm, until } from './fake-live.js';

let db: Firestore;
let kb: Kb;
let sequence = 0;
beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-voice-memory-${process.pid}-${Date.now()}` });
  kb = await Kb.load(
    new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
  );
});
afterAll(() => db.terminate());

async function setup(mode = 'cleared') {
  const child = (await new DevChildDirectory(db).lookup(`c_memory_${sequence++}`))!;
  const root = db.doc(`families/${child.familyId}/children/${child.childId}`);
  const model = new FakeLiveLlm();
  const calls: ToolCallReq[] = [];
  const logs: string[] = [];
  const rt = await createVoiceRuntime({
    db,
    kb,
    logger: new Logger('voice-memory-test', (line) => logs.push(line)),
    createModel: () => ({ model, connected: model.connected }),
    publish: async () => {},
    callTool: async (name, request) => {
      if (name === 'recall') {
        calls.push(request);
        if (mode === 'unavailable') throw new Error('PRIVATE_FAILURE_SENTINEL');
        if (mode === 'malformed') return { memories: 'not-an-array' };
        if (mode === 'empty') return { memories: [] };
        if (mode === 'revoked_during_read') await root.update({ memoryRevision: 1 });
        return { memories: ['ねこが好き。'] };
      }
      return {
        gradeBand: 'high',
        characterId: 'moko',
        localTime: '',
        dayType: 'school_day',
        recentTrend: '',
        careFlag: false,
      };
    },
  });
  const saved = await rt.sessions.createSession({ appName: 'pet', userId: child.childId });
  const message = await rt.sessions.writeChildMessage(child.childId, saved.id, {
    text: 'ねこのおはなし',
    inputMode: 'typed',
    crisisCheck: { hit: mode === 'crisis', method: 'none', score: 0, checkedAt: new Date() },
  });
  const messageRef = root.collection(`sessions/${saved.id}/messages`).doc(message.messageId);
  if (mode === 'expired') await messageRef.update({ expireAt: new Date(0) });
  if (mode === 'unscreened') await messageRef.set({ crisisCheck: null }, { merge: true });
  if (mode === 'reset') await root.update({ modelHistoryResetAt: new Date(Date.now() + 1000) });
  if (mode === 'other_pet')
    await root.collection('sessions').doc(saved.id).update({ petId: 'other_pet' });
  if (mode === 'safe_session')
    await root.collection('sessions').doc(saved.id).update({ safeMode: true });
  if (mode === 'expired_session')
    await root
      .collection('sessions')
      .doc(saved.id)
      .update({ expireAt: new Date(0) });
  const backend = createVoiceBackend(rt);
  return { child, root, model, calls, logs, backend };
}

it('prefetches through pet-agent using the latest screened topic before creating a Live model', async () => {
  const t = await setup();
  const opened = await t.backend.open(t.child, {}, { send: () => {}, closeSocket: () => {} });
  try {
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.args).toEqual({ topic: 'ねこのおはなし' });
    expect(JSON.stringify(t.model.connections[0]?.request.config?.systemInstruction)).toContain(
      'ねこが好き。',
    );
    expect(t.logs.join('\n')).not.toContain('ねこ');
  } finally {
    await opened.live.close();
    await opened.session.stop();
  }
});

it('does not invent memory when the pet-agent returns no relevant consented result', async () => {
  const t = await setup('empty');
  const opened = await t.backend.open(t.child, {}, { send: () => {}, closeSocket: () => {} });
  try {
    expect(t.calls).toHaveLength(1);
    expect(JSON.stringify(t.model.connections[0]?.request.config?.systemInstruction)).not.toContain(
      'ねこが好き。',
    );
  } finally {
    await opened.live.close();
    await opened.session.stop();
  }
});

it.each(['unavailable', 'malformed', 'revoked_during_read'])(
  'does not open a Live model with %s context',
  async (mode) => {
    const t = await setup(mode);
    await expect(
      t.backend.open(t.child, {}, { send: () => {}, closeSocket: () => {} }),
    ).rejects.toThrow();
    expect(t.model.connections).toEqual([]);
    expect(t.logs.join('\n')).not.toContain('PRIVATE_FAILURE_SENTINEL');
  },
);

it.each([
  'crisis',
  'unscreened',
  'expired',
  'reset',
  'other_pet',
  'safe_session',
  'expired_session',
])('does not prefetch a topic from %s history', async (mode) => {
  const t = await setup(mode);
  const opened = await t.backend.open(t.child, {}, { send: () => {}, closeSocket: () => {} });
  try {
    expect(t.calls).toEqual([]);
    expect(JSON.stringify(t.model.connections[0]?.request.config?.systemInstruction)).not.toContain(
      'ねこが好き。',
    );
  } finally {
    await opened.live.close();
    await opened.session.stop();
  }
});

it('closes the prefetched Live context when memory is deleted or the pet changes', async () => {
  for (const update of [{ memoryRevision: 1 }, { activePetId: 'new_pet' }]) {
    const t = await setup();
    const opened = await t.backend.open(t.child, {}, { send: () => {}, closeSocket: () => {} });
    const running = opened.session.attach(opened.live);
    try {
      expect(t.calls).toHaveLength(1);
      await t.root.update(update);
      await until(() => opened.session.isEnded);
      await running;
      expect(t.model.connections[0]?.closed).toBe(true);
    } finally {
      await opened.live.close();
      await opened.session.stop();
    }
  }
});
