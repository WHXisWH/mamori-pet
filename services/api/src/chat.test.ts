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
import { CrisisDetector, KeywordMatcher, ModelCallError } from '@ijime/crisis-detector';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { createApp as createPetAgentApp } from '@ijime/pet-agent/src/app.js';
import { createRuntime as createPetRuntime } from '@ijime/pet-agent/src/runtime.js';
import { Logger, type CrisisRecheckTask } from '@ijime/service-kit';
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
    expect(crisis.data.resources.map((r) => r.id)).toEqual(['sos_dial', 'childline', 'emergency']);

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
      category: 'family_harm',
      familyHarmSuspected: true,
    });
  });

  describe('model unavailable (docs/02-agent-architecture.md「危機検知器」)', () => {
    const down = () =>
      new CrisisDetector(
        new KeywordMatcher(['死にたい']),
        {
          screen: async () => {
            throw new ModelCallError('quota');
          },
        },
        {
          review: async () => {
            throw new ModelCallError('quota');
          },
        },
        { screenTimeoutMs: 200, reviewTimeoutMs: 200, random: () => 0 },
      );
    const pausedApp = (requestRecheck: ChatDeps['requestRecheck']) =>
      createApp({
        getKb: async () => {
          throw new Error('unused');
        },
        allowedOrigins: [],
        chat: async () => ({
          ...chatDeps,
          detector: down(),
          requestRecheck,
          petAgent: {
            // eslint-disable-next-line require-yield
            async *turn() {
              throw new Error('the pet must not see an unchecked message');
            },
          },
        }),
      });
    const send = async (a: ReturnType<typeof createApp>, sessionId: string, text: string) =>
      a.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ text, inputMode: 'typed', clientSentAt: new Date().toISOString() }),
      });

    it('pauses an unmatched message: fixed reply and help, pending review, recheck queued', async () => {
      const tasks: CrisisRecheckTask[] = [];
      const a = pausedApp(async (t) => void tasks.push(t));
      const sessionId = await startSession();
      const before = published.length;
      const events = await sse(await send(a, sessionId, 'PAUSED_SENTINEL_きょうのはなし'));
      expect(events.map((e) => e.event)).toEqual([
        'meta',
        'action',
        'action',
        'review',
        'delta',
        'done',
      ]);
      const meta = events[0] as { data: { messageId: string; safeMode: boolean } };
      expect(meta.data.safeMode).toBe(false);
      expect(events[1]!.data).toEqual({ type: 'set_expression', expression: 'sleepy' });
      expect(events[2]!.data).toEqual({ type: 'show_help_resources' });
      expect(events[3]).toMatchObject({
        event: 'review',
        data: { status: 'pending_review', messageId: meta.data.messageId },
      });
      expect((events[4] as { data: { text: string } }).data.text).toBe(chatDeps.pausedReplies.high);
      const safety = await a.request(`/v1/child/chat/sessions/${sessionId}/safety`, { headers: H });
      expect(safety.status).toBe(200);
      const pending = (await safety.json()) as { status: string; resources: { id: string }[] };
      expect(pending.status).toBe('pending_review');
      expect(pending.resources.slice(0, 2).map((r) => r.id)).toEqual(['emergency', 'jidou_soudan']);
      expect(pending.resources.map((r) => r.id)).toEqual(
        expect.arrayContaining(['emergency', 'jidou_soudan']),
      );
      const retry = await a.request(
        `/v1/child/chat/sessions/${sessionId}/messages/${meta.data.messageId}/reply`,
        { method: 'POST', headers: H },
      );
      expect(retry.status).toBe(409);
      expect(tasks).toEqual([
        {
          familyId: 'f_dev_c_api1',
          childId: 'c_api1',
          sessionId,
          messageId: meta.data.messageId,
          channel: 'text',
        },
      ]);
      const stored = await db
        .doc(
          `families/f_dev_c_api1/children/c_api1/sessions/${sessionId}/messages/${meta.data.messageId}`,
        )
        .get();
      expect(stored.get('crisisCheck')).toMatchObject({
        hit: false,
        method: 'paused',
        pendingReview: true,
      });
      expect(published.slice(before)).toEqual([]);
      expect(logLines.join('\n')).not.toContain('PAUSED_SENTINEL');
    });

    it('a keyword hit is still a crisis (category other) while models are down', async () => {
      const a = pausedApp(async () => {
        throw new Error('must not queue a keyword hit');
      });
      const sessionId = await startSession();
      const before = published.length;
      const events = await sse(await send(a, sessionId, 'もう死にたい'));
      expect(events.map((e) => e.event)).toEqual(['meta', 'crisis']);
      expect(published.slice(before).at(-1)).toMatchObject({
        topic: 'crisis.detected',
        payload: { category: 'other', familyHarmSuspected: false },
      });
    });

    it('still answers with the fixed reply when the recheck cannot be queued, and logs it', async () => {
      const a = pausedApp(async () => {
        throw new Error('queue down');
      });
      const sessionId = await startSession();
      const events = await sse(await send(a, sessionId, 'ふつうの はなし'));
      expect(events.map((e) => e.event)).toEqual([
        'meta',
        'action',
        'action',
        'review',
        'delta',
        'done',
      ]);
      expect(logLines.some((l) => l.includes('crisis.recheck_enqueue_failed'))).toBe(true);
    });
  });

  it('retries a confirmed no-tool fallback once using the saved input, without another message or event', async () => {
    let calls = 0;
    const inputs: string[] = [];
    const a = createApp({
      getKb: async () => {
        throw new Error('unused');
      },
      allowedOrigins: [],
      chat: async () => ({
        ...chatDeps,
        petAgent: {
          async *turn(req) {
            inputs.push(req.messageId);
            calls++;
            yield {
              type: 'delta' as const,
              text: calls === 1 ? 'いま、うまく話せないよ。' : 'いっしょに考えよう。',
            };
            yield {
              type: 'done' as const,
              replyMessageId: calls === 1 ? 'fallback_test' : 'reply_test',
              retryable: calls === 1,
            };
          },
        },
      }),
    });
    const sessionId = await startSession();
    const before = published.length;
    const events = await sse(
      await a.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          text: 'いっしょに考えてほしい',
          inputMode: 'typed',
          clientSentAt: new Date().toISOString(),
        }),
      }),
    );
    const messageId = (events[0] as { data: { messageId: string } }).data.messageId;
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { retryable: true } });
    const path = `/v1/child/chat/sessions/${sessionId}/messages/${messageId}/reply`;
    const resumed = await sse(await a.request(path, { method: 'POST', headers: H }));
    expect(resumed[0]).toMatchObject({ event: 'meta', data: { messageId } });
    expect(resumed.at(-1)).toMatchObject({ event: 'done', data: { replyMessageId: 'reply_test' } });
    expect(inputs).toEqual([messageId, messageId]);
    expect((await a.request(path, { method: 'POST', headers: H })).status).toBe(409);
    expect(published.slice(before).filter((p) => p.topic === 'message.created')).toHaveLength(1);
    const messages = await db
      .collection(`families/f_dev_c_api1/children/c_api1/sessions/${sessionId}/messages`)
      .get();
    expect(messages.docs.filter((d) => d.get('role') === 'child')).toHaveLength(1);
  });

  it('safety status reveals a delayed family crisis only to the owning child', async () => {
    const sessionId = await startSession();
    const base = 'families/f_dev_c_api1/children/c_api1';
    await db
      .doc(`${base}/crisisEvents/delayed`)
      .set({ status: 'open', category: 'family_harm', familyHarmSuspected: true });
    const path = `/v1/child/chat/sessions/${sessionId}/safety`;
    const res = await app.request(path, { headers: H });
    expect(res.status).toBe(200);
    const result = (await res.json()) as {
      status: string;
      crisis: { resources: { id: string }[] };
    };
    expect(result.status).toBe('crisis');
    expect(result.crisis.resources.map((r) => r.id)).toEqual(['jidou_soudan', 'emergency']);
    expect(
      (await app.request(path, { headers: { ...H, 'X-Dev-Child-Id': 'c_other' } })).status,
    ).toBe(404);
  });

  it('resumes a released review once and excludes concurrent replies, stale inputs and completed replies', async () => {
    const sessionId = await startSession();
    const base = `families/f_dev_c_api1/children/c_api1/sessions/${sessionId}`;
    const { messageId } = await chatDeps.sessions.writeChildMessage('c_api1', sessionId, {
      text: '保存した話をつづけたい',
      inputMode: 'typed',
      crisisCheck: {
        hit: false,
        method: 'paused',
        score: 0,
        checkedAt: new Date(),
        pendingReview: true,
      },
    });
    await db.doc(base).update({ latestInputMessageId: messageId });
    await db.doc(`${base}/messages/${messageId}`).update({ replyState: 'awaiting_review' });
    const path = `/v1/child/chat/sessions/${sessionId}/messages/${messageId}/reply`;
    expect((await app.request(path, { method: 'POST', headers: H })).status).toBe(409);
    await db
      .doc(`${base}/messages/${messageId}`)
      .update({ 'crisisCheck.pendingReview': false, 'crisisCheck.method': 'none' });
    expect(
      await (
        await app.request(`/v1/child/chat/sessions/${sessionId}/safety`, { headers: H })
      ).json(),
    ).toEqual({ status: 'clear', resumeMessageId: messageId });
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const a = createApp({
      getKb: async () => {
        throw new Error('unused');
      },
      allowedOrigins: [],
      chat: async () => ({
        ...chatDeps,
        petAgent: {
          async *turn() {
            calls++;
            await wait;
            yield { type: 'done' as const, replyMessageId: 'reply_recovered' };
          },
        },
      }),
    });
    const first = a.request(path, { method: 'POST', headers: H });
    const response = await first;
    expect(response.status).toBe(200);
    const body = sse(response);
    try {
      expect((await a.request(path, { method: 'POST', headers: H })).status).toBe(409);
    } finally {
      release();
    }
    expect((await body).at(-1)).toMatchObject({
      event: 'done',
      data: { replyMessageId: 'reply_recovered' },
    });
    expect(calls).toBe(1);
    expect((await a.request(path, { method: 'POST', headers: H })).status).toBe(409);
    await db.doc(`${base}/messages/${messageId}`).update({ replyState: 'retryable' });
    await db.doc(base).update({ latestInputMessageId: 'newer_input' });
    expect((await a.request(path, { method: 'POST', headers: H })).status).toBe(409);
  });

  it('does not permit replay after tools or an unknown relay failure', async () => {
    for (const mode of ['tool', 'disconnect']) {
      const sessionId = await startSession();
      const a = createApp({
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
                action: { type: 'offer_tell_adult' as const, consultationId: 'existing_offer' },
              };
              if (mode === 'disconnect') throw new Error('relay_failed');
              yield {
                type: 'done' as const,
                replyMessageId: 'fallback_after_tool',
                retryable: false,
              };
            },
          },
        }),
      });
      const events = await sse(
        await a.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: H,
          body: JSON.stringify({
            text: 'はなしを聞いて',
            inputMode: 'typed',
            clientSentAt: new Date().toISOString(),
          }),
        }),
      );
      const messageId = (events[0] as { data: { messageId: string } }).data.messageId;
      const done = events.at(-1) as { data: { retryable?: boolean } };
      expect(done.data.retryable).not.toBe(true);
      expect(
        (
          await a.request(`/v1/child/chat/sessions/${sessionId}/messages/${messageId}/reply`, {
            method: 'POST',
            headers: H,
          })
        ).status,
      ).toBe(409);
    }
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
