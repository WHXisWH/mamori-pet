import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  petDemoScript,
  ScriptedLlm,
} from '@ijime/agent-core';
import type { SseEvent, StartSessionRes } from '@ijime/api-types';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { createApp as createPetAgentApp } from '@ijime/pet-agent/src/app.js';
import { createRuntime as createPetRuntime } from '@ijime/pet-agent/src/runtime.js';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { ChatDeps } from './chat.js';
import { AppPetAgentClient } from './pet-agent-client.js';
import { createApiRuntime } from './runtime.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const H = { 'Content-Type': 'application/json', 'X-Dev-Child-Id': 'c_api1' };

let db: Firestore;
let app: ReturnType<typeof createApp>;
let chatDeps: ChatDeps;
const published: { topic: string; payload: Record<string, unknown> }[] = [];
const logLines: string[] = [];

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  const directory = new DevChildDirectory(db);
  const petRuntime = await createPetRuntime({
    kb,
    db,
    directory,
    sessions: new FirestoreSessionService(db, directory, { writeUserEvents: false }),
    model: new ScriptedLlm(petDemoScript()),
    logger: new Logger('pet-agent', (l) => logLines.push(l)),
  });
  const petApp = createPetAgentApp(async () => petRuntime);
  const rt = await createApiRuntime({
    kb,
    db,
    directory,
    petAgent: new AppPetAgentClient(petApp as never),
    logger: new Logger('api', (l) => logLines.push(l)),
    publish: async (topic, payload) => void published.push({ topic, payload }),
    auth: { allowDevHeader: true },
  });
  chatDeps = rt.chat;
  app = createApp({
    getKb: async () => kb,
    allowedOrigins: ['http://localhost:3000'],
    chat: async () => rt.chat,
  });
  await app.request('/healthz');
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(() => db.terminate());
beforeEach(async () => {
  await db.recursiveDelete(db.collection('families/f_dev_c_api1/children/c_api1/crisisEvents'));
});

async function sse(res: Response): Promise<SseEvent[]> {
  expect(res.headers.get('Content-Type')).toContain('text/event-stream');
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? '';
      const data = /^data: (.+)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(data) } as SseEvent;
    });
}

async function startSession(): Promise<string> {
  const res = await app.request('/v1/child/chat/sessions', {
    method: 'POST',
    headers: H,
    body: '{}',
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as StartSessionRes;
  expect(body.openingMessage.length).toBeGreaterThan(0);
  return body.sessionId;
}

describe('chat API', () => {
  it('requires authentication', async () => {
    const res = await app.request('/v1/child/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('a normal turn: meta → delta… → action → done, and the message is stored encrypted with typing metrics', async () => {
    const sessionId = await startSession();
    const res = await app.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        text: 'きょうは たのしかった！',
        inputMode: 'typed',
        typing: { keyCount: 12, deleteCount: 1, composeMs: 3000, longPauseCount: 0 },
        clientSentAt: new Date().toISOString(),
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const events = await sse(res);
    expect(events[0]?.event).toBe('meta');
    expect((events[0] as { data: { safeMode: boolean } }).data.safeMode).toBe(false);
    expect(events.some((e) => e.event === 'action')).toBe(true);
    expect(events.filter((e) => e.event === 'delta').length).toBeGreaterThan(0);
    expect(events.at(-1)?.event).toBe('done');

    const list = await app.request(`/v1/child/chat/sessions/${sessionId}/messages`, { headers: H });
    const body = (await list.json()) as { items: { role: string; text: string }[] };
    expect(body.items.map((m) => m.role)).toEqual(['child', 'pet']);
    expect(body.items[0]?.text).toBe('きょうは たのしかった！');

    const raw = await db
      .collection(`families/f_dev_c_api1/children/c_api1/sessions/${sessionId}/messages`)
      .get();
    const childDoc = raw.docs.find((d) => d.data()['role'] === 'child')!.data();
    expect(childDoc['typing']).toEqual({
      keyCount: 12,
      deleteCount: 1,
      composeMs: 3000,
      longPauseCount: 0,
    });
    expect(childDoc['crisisCheck']['hit']).toBe(false);
    expect(Buffer.from(childDoc['contentEnc']).toString('utf8')).not.toContain('たのしかった');
    expect(published.map((p) => p.topic)).toContain('message.created');
    expect(JSON.stringify(published)).not.toContain('たのしかった');
    const timing = logLines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'chat.turn' && entry.sessionId === sessionId);
    expect(timing).toMatchObject({ fallback: false, firstTokenTargetMs: 2000 });
    expect(timing.firstVisibleTextMs).toBeGreaterThanOrEqual(timing.safetyLatencyMs);
    expect(timing.latencyMs).toBeGreaterThanOrEqual(timing.firstVisibleTextMs);
  });

  it('crisis language never reaches the agent: crisis event, safe mode, hotlines, Pub/Sub', async () => {
    const before = logLines.length;
    const sessionId = await startSession();
    const res = await app.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        text: 'もう 消えたい',
        inputMode: 'typed',
        clientSentAt: new Date().toISOString(),
      }),
    });
    const events = await sse(res);
    expect(events.map((e) => e.event)).toEqual(['meta', 'crisis']);
    expect((events[0] as { data: { safeMode: boolean } }).data.safeMode).toBe(true);
    const crisis = events[1] as {
      data: { crisisId: string; message: string; resources: { id: string }[] };
    };
    expect(crisis.data.message).toContain('あなたの安全がいちばん大事');
    expect(crisis.data.message).not.toContain('おうちの人に知らせるね');
    expect(crisis.data.resources.map((r) => r.id)).toEqual(['sos_dial', 'childline']);

    const session = (
      await db.doc(`families/f_dev_c_api1/children/c_api1/sessions/${sessionId}`).get()
    ).data()!;
    expect(session['safeMode']).toBe(true);
    const crisisDoc = (
      await db
        .doc(`families/f_dev_c_api1/children/c_api1/crisisEvents/${crisis.data.crisisId}`)
        .get()
    ).data()!;
    expect(crisisDoc['status']).toBe('open');
    expect(crisisDoc['detection']['keywordMatched']).toBe(true);
    expect(published.find((p) => p.topic === 'crisis.detected')?.payload).toMatchObject({
      childId: 'c_api1',
      crisisId: crisis.data.crisisId,
      familyHarmSuspected: false,
    });

    const msgs = await db
      .collection(`families/f_dev_c_api1/children/c_api1/sessions/${sessionId}/messages`)
      .get();
    expect(msgs.docs.map((d) => d.data()['role'])).toEqual(['child']);
    expect(logLines.slice(before).some((l) => l.includes('"event":"crisis.detected"'))).toBe(true);
    expect(logLines.slice(before).some((l) => l.includes('agent.turn'))).toBe(false);
    for (const id of [sessionId, await startSession()]) {
      const again = await app.request(`/v1/child/chat/sessions/${id}/messages`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          text: 'こんにちは',
          inputMode: 'typed',
          clientSentAt: new Date().toISOString(),
        }),
      });
      expect((await sse(again)).map((e) => e.event)).toEqual(['meta', 'crisis']);
    }
  });

  it('the pet escalating mid-turn: crisis copy and hotlines replace the reply, crisis.detected published', async () => {
    const stubApp = createApp({
      getKb: async () => {
        throw new Error('unused');
      },
      allowedOrigins: [],
      chat: async () => ({
        ...chatDeps,
        petAgent: {
          async *turn() {
            yield {
              type: 'action' as const,
              action: { type: 'set_expression' as const, expression: 'worried' as const },
            };
            yield { type: 'crisis' as const, crisisId: 'k_agent' };
            yield { type: 'delta' as const, text: 'NEVER_SHOWN' };
          },
        },
      }),
    });
    const s = await stubApp.request('/v1/child/chat/sessions', {
      method: 'POST',
      headers: H,
      body: '{}',
    });
    const { sessionId } = (await s.json()) as StartSessionRes;
    const before = published.length;
    const res = await stubApp.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        text: 'ねえ',
        inputMode: 'typed',
        clientSentAt: new Date().toISOString(),
      }),
    });
    const events = await sse(res);
    expect(events.map((e) => e.event)).toEqual(['meta', 'action', 'crisis']);
    const crisis = events[2] as { data: { crisisId: string; resources: { id: string }[] } };
    expect(crisis.data.crisisId).toBe('k_agent');
    expect(crisis.data.resources.map((r) => r.id)).toEqual(['jidou_soudan', 'emergency']);
    expect(published.slice(before).map((p) => p.topic)).toEqual([
      'message.created',
      'crisis.detected',
    ]);
    expect(published.at(-1)!.payload).toEqual({
      childId: 'c_api1',
      crisisId: 'k_agent',
      familyHarmSuspected: true,
    });
  });

  it('validates the message body and session ownership', async () => {
    const sessionId = await startSession();
    const bad = await app.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ text: '' }),
    });
    expect(bad.status).toBe(400);
    const other = await app.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
      headers: { ...H, 'X-Dev-Child-Id': 'c_other' },
    });
    expect(other.status).toBe(404);
  });

  it('lists and deletes sessions', async () => {
    const sessionId = await startSession();
    const list = await app.request('/v1/child/chat/sessions', { headers: H });
    expect(
      ((await list.json()) as { items: { sessionId: string }[] }).items.map((s) => s.sessionId),
    ).toContain(sessionId);
    const del = await app.request(`/v1/child/chat/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: H,
    });
    expect(del.status).toBe(204);
    const gone = await app.request(`/v1/child/chat/sessions/${sessionId}/messages`, { headers: H });
    expect(gone.status).toBe(404);
  });

  it('logs and events never contain child text', () => {
    expect(logLines.join('\n')).not.toMatch(/たのしかった|消えたい/);
  });

  it('limits ordinary daily chat while preserving emergency handling', async () => {
    const id = `c_budget_${Date.now()}`;
    const headers = { ...H, 'X-Dev-Child-Id': id };
    const session = await app.request('/v1/child/chat/sessions', {
      method: 'POST',
      headers,
      body: '{}',
    });
    const { sessionId } = (await session.json()) as StartSessionRes;
    const date = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    await db.doc(`families/f_dev_${id}/children/${id}/chatUsage/${date}`).set({ turns: 60 });
    const send = (text: string) =>
      app.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text, inputMode: 'typed', clientSentAt: new Date().toISOString() }),
      });
    expect((await send('こんにちは')).status).toBe(429);
    expect((await sse(await send('もう消えたい'))).map((e) => e.event)).toEqual(['meta', 'crisis']);
  });
});
