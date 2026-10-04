import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory } from '@ijime/agent-core';
import type { ToolCallReq } from '@ijime/api-types';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createVoiceBackend } from '../src/backend.js';
import { createVoiceRuntime } from '../src/runtime.js';
import { FakeLiveLlm, until } from './fake-live.js';

let db: Firestore;
beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-voice-operation-${process.pid}` });
});
afterAll(() => db.terminate());

it('supplies a stable valid operation ID per utterance through the actual Live tool bridge', async () => {
  const child = (await new DevChildDirectory(db).lookup('c_voice_operation'))!;
  const model = new FakeLiveLlm();
  const calls: ToolCallReq[] = [];
  const rt = await createVoiceRuntime({
    db,
    kb: await Kb.load(
      new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
    ),
    logger: new Logger('voice-operation-test', () => {}),
    createModel: () => ({ model, connected: model.connected }),
    publish: async () => {},
    callTool: async (name, request) => {
      if (name === 'suggest_game') {
        calls.push(request);
        return { ok: true };
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
  vi.spyOn(rt.detector, 'check').mockResolvedValue({
    hit: false,
    category: 'none',
    familyHarmSuspected: false,
    method: 'none',
    keywordMatched: false,
    confidence: 0,
    latencyMs: 0,
  });
  const opened = await createVoiceBackend(rt).open(
    child,
    {},
    { send: () => {}, closeSocket: () => {} },
  );
  const running = opened.session.attach(opened.live);
  const connection = model.connections[0]!;
  const suggest = (id: string) =>
    connection.server.push({
      content: {
        role: 'model',
        parts: [{ functionCall: { id, name: 'suggest_game', args: { type: 'drawing' } } }],
      },
    });
  try {
    connection.server.push({ inputTranscription: { text: '遊ぼう', finished: true } });
    await until(() => opened.session.canExecuteTools);
    suggest('first');
    await until(() => calls.length === 1);
    expect(calls[0]!.operationId).toMatch(/^[a-zA-Z0-9_-]{1,200}$/);
    await rt.sessions.writePetTranscript(child.childId, opened.sessionId, 'いっしょに遊ぼう。');
    suggest('retry');
    await until(() => calls.length === 2);
    expect(calls[1]!.operationId).toBe(calls[0]!.operationId);
    const previousTurn = opened.session.toolTurnId;
    connection.server.push({ inputTranscription: { text: 'もう一度', finished: false } });
    connection.server.push({ inputTranscription: { text: 'もう一度遊ぼう', finished: true } });
    await until(() => opened.session.toolTurnId !== previousTurn && opened.session.canExecuteTools);
    suggest('next_turn');
    await until(() => calls.length === 3);
    expect(calls[2]!.operationId).toMatch(/^[a-zA-Z0-9_-]{1,200}$/);
    expect(calls[2]!.operationId).not.toBe(calls[0]!.operationId);
  } finally {
    await opened.session.stop();
    await running;
  }
});
