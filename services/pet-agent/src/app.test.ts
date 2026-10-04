import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  PET_APP_NAME,
  petDemoScript,
  ScriptedLlm,
} from '@ijime/agent-core';
import type { TurnChunk } from '@ijime/api-types';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger, eventSchemas, type Publisher } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, SERVICE_NAME } from './app.js';
import { createRuntime, type PetRuntime } from './runtime.js';
import { createExecutor } from './executor.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');

let db: Firestore;
let runtime: PetRuntime;
let sessions: FirestoreSessionService;
const logLines: string[] = [];

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-ijime-pet-tests-${process.pid}` });
  const directory = new DevChildDirectory(db);
  sessions = new FirestoreSessionService(db, directory, { writeUserEvents: false });
  runtime = await createRuntime({
    kb: await Kb.load(new FsKbSource(KB_DIR)),
    db,
    directory,
    sessions,
    model: new ScriptedLlm(petDemoScript()),
    logger: new Logger('pet-agent', (l) => logLines.push(l)),
  });
});

afterAll(() => db.terminate());

async function turn(
  childId: string,
  text: string,
): Promise<{ chunks: TurnChunk[]; sessionId: string; messageId: string }> {
  const app = createApp(async () => runtime);
  const s = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
  const { messageId } = await sessions.writeChildMessage(childId, s.id, {
    text,
    inputMode: 'typed',
    crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
  });
  const res = await app.request('/internal/turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ childId, sessionId: s.id, messageId }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('Content-Type')).toContain('application/x-ndjson');
  const chunks = (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TurnChunk);
  return { chunks, sessionId: s.id, messageId };
}

describe('pet-agent /internal/turns', () => {
  it('answers /healthz', async () => {
    const res = await createApp(async () => runtime).request('/healthz');
    expect(await res.json()).toMatchObject({ status: 'ok', service: SERVICE_NAME });
  });

  it('streams delta/action/done and persists the pet reply encrypted', async () => {
    const { chunks, sessionId } = await turn('c_pa1', 'きょうは たのしかった！');
    expect(chunks.map((c) => c.type)).toEqual(expect.arrayContaining(['action', 'delta', 'done']));
    expect(chunks.at(-1)?.type).toBe('done');
    const text = chunks
      .filter((c) => c.type === 'delta')
      .map((c) => (c as { text: string }).text)
      .join('');
    expect(text).toContain('いいね');
    const msgs = await sessions.readMessages('c_pa1', sessionId);
    expect(msgs.map((m) => m.role)).toEqual(['child', 'pet']);
    expect(msgs[1]?.text).toBe(text);
    const raw = await db
      .collection(`families/f_dev_c_pa1/children/c_pa1/sessions/${sessionId}/messages`)
      .get();
    for (const d of raw.docs)
      expect(Buffer.from(d.data()['contentEnc']).toString('utf8')).not.toContain('いいね');
  });

  it('the agent chooses tools: start_tell_adult writes a consultation and emits offer_tell_adult', async () => {
    const { chunks } = await turn('c_pa2', 'みんなに 無視された');
    const offer = chunks.find((c) => c.type === 'action' && c.action.type === 'offer_tell_adult');
    expect(offer).toBeDefined();
    const consultations = await db
      .collection('families/f_dev_c_pa2/children/c_pa2/consultations')
      .get();
    expect(consultations.size).toBe(1);
    expect(consultations.docs[0]?.data()['source']).toBe('child_initiated');
  });

  it('escalate_crisis ends the turn with a crisis chunk and no pet text', async () => {
    const { chunks, sessionId } = await turn('c_pa5', 'もう しにたい');
    expect(chunks.some((c) => c.type === 'delta' || c.type === 'done')).toBe(false);
    const last = chunks.at(-1);
    expect(last?.type).toBe('crisis');
    const crisisId = (last as { crisisId: string }).crisisId;
    const base = 'families/f_dev_c_pa5/children/c_pa5';
    const doc = (await db.doc(`${base}/crisisEvents/${crisisId}`).get()).data()!;
    expect(doc).toMatchObject({
      triggerType: 'text',
      sourceRef: `${base}/sessions/${sessionId}`,
      detection: { source: 'agent_tool', reason: 'suicidal' },
      status: 'open',
    });
    expect((await db.doc(`${base}/sessions/${sessionId}`).get()).data()!['safeMode']).toBe(true);
  });

  it('remember stores only an encrypted proposal until child confirmation', async () => {
    const { chunks } = await turn('c_pa3', 'ねこが すきなこと、おぼえてて');
    expect(chunks.some((c) => c.type === 'delta')).toBe(true);
    const memories = await db.collection('families/f_dev_c_pa3/children/c_pa3/memories').get();
    expect(memories.size).toBe(0);
    const proposals = await db
      .collection('families/f_dev_c_pa3/children/c_pa3/memoryProposals')
      .get();
    expect(proposals.size).toBe(1);
    expect(proposals.docs[0]!.data()['status']).toBe('pending');
    expect(chunks.some((c) => c.type === 'action' && c.action.type === 'memory_proposal')).toBe(
      true,
    );
    const reply = chunks.flatMap((c) => (c.type === 'delta' ? [c.text] : [])).join('');
    expect(reply).toContain('おぼえても いい');
    expect(reply).not.toContain('おぼえておく');
    expect(Buffer.from(proposals.docs[0]!.data()['contentEnc']).toString('utf8')).not.toContain(
      'ねこ',
    );
  });

  it('rejects unknown messages and bad bodies', async () => {
    const app = createApp(async () => runtime);
    const bad = await app.request('/internal/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(bad.status).toBe(400);
    const s = await sessions.createSession({ appName: PET_APP_NAME, userId: 'c_pa4' });
    const nf = await app.request('/internal/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId: 'c_pa4', sessionId: s.id, messageId: 'nope' }),
    });
    expect(nf.status).toBe(404);
  });

  it('never logs child text', () => {
    expect(logLines.join('\n')).not.toMatch(/無視された|たのしかった|ねこが|しにたい/);
  });

  it('validates internal tool arguments and rejects another child session', async () => {
    const app = createApp(async () => runtime);
    const session = await sessions.createSession({ appName: PET_APP_NAME, userId: 'c_tool_owner' });
    const post = (childId: string, args: unknown) =>
      app.request('/internal/tools/record_mood', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childId, sessionId: session.id, args }),
      });
    expect((await post('c_tool_owner', { weather: 'snowy' })).status).toBe(400);
    expect((await post('c_tool_owner', { weather: 'rainy', childId: 'other' })).status).toBe(400);
    expect((await post('c_other', { weather: 'rainy' })).status).toBe(404);
  });

  it('retries a memory proposal without creating duplicate proposals or memories', async () => {
    const app = createApp(async () => runtime);
    const session = await sessions.createSession({
      appName: PET_APP_NAME,
      userId: 'c_tool_memory',
    });
    const post = () =>
      app.request('/internal/tools/remember', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          childId: 'c_tool_memory',
          sessionId: session.id,
          operationId: 'turn_1',
          args: { content: 'ねこが すき', category: 'like' },
        }),
      });
    const first = await post();
    const second = await post();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    const path = 'families/f_dev_c_tool_memory/children/c_tool_memory';
    expect((await db.collection(`${path}/memoryProposals`).get()).size).toBe(1);
    expect((await db.collection(`${path}/memories`).get()).size).toBe(0);
  });

  it('recalls only accepted current-character relevant memories and reflects deletions immediately', async () => {
    const childId = 'c_recall';
    const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const child = (await runtime.directory.lookup(childId))!;
    const path = `families/${child.familyId}/children/${childId}/memories`;
    for (const [id, extra] of Object.entries({
      approved: { status: 'accepted', characterId: 'moko' },
      pending: { status: 'pending', characterId: 'moko' },
      other: { status: 'accepted', characterId: 'pokke' },
      expired: { status: 'accepted', characterId: 'moko', expiresAt: new Date(0) },
    }))
      await db.doc(`${path}/${id}`).set({
        contentEnc: sessions.encryptForChild(child, 'サッカーが すき', `${path}#contentEnc`),
        category: 'like',
        createdAt: new Date(),
        ...extra,
      });
    const executor = runtime.executorFor(child, session.id, []);
    const ctx = {
      childId,
      sessionId: session.id,
      gradeBand: child.gradeBand,
      characterId: child.characterId,
    };
    expect(await executor.recall(ctx, 'サッカー')).toEqual(['サッカーが すき']);
    expect(await executor.recall(ctx, 'バスケットボール')).toEqual([]);
    await db.doc(`${path}/approved`).delete();
    expect(await executor.recall(ctx, 'サッカー')).toEqual([]);
  });

  it('reuses pending consultations, reopens due follow-up once and never writes risk', async () => {
    const childId = 'c_followup';
    const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const child = (await runtime.directory.lookup(childId))!;
    const base = `families/${child.familyId}/children/${childId}`;
    await db.doc(`${base}/consultations/due`).set({
      level: 'l2',
      choice: 'not_now',
      offerCount: 1,
      offeredAt: new Date(0),
      followUpAt: new Date(0),
    });
    const executor = runtime.executorFor(child, session.id, []);
    const ctx = {
      childId,
      sessionId: session.id,
      gradeBand: child.gradeBand,
      characterId: child.characterId,
    };
    expect((await executor.getChildContext(ctx)).pendingConsultationId).toBe('due');
    expect(await executor.startTellAdult(ctx)).toEqual({ consultationId: 'due' });
    expect(await executor.startTellAdult(ctx)).toEqual({ consultationId: 'due' });
    expect((await db.doc(`${base}/consultations/due`).get()).data()).toMatchObject({
      offerCount: 2,
    });
    expect((await db.doc(`${base}/consultations/due`).get()).get('choice')).toBeUndefined();
    expect((await db.doc(base).get()).get('currentRiskLevel')).toBe('l0');
  });

  it('blocks another session when the child has an open crisis', async () => {
    const childId = 'c_crisis_lock';
    const s = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const other = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const child = (await runtime.directory.lookup(childId))!;
    const ctx = {
      childId,
      sessionId: s.id,
      gradeBand: child.gradeBand,
      characterId: child.characterId,
    };
    const first = runtime.executorFor(child, s.id, []);
    const crisis = await first.escalateCrisis(ctx, 'violence');
    const doc = await db
      .doc(`families/${child.familyId}/children/${childId}/crisisEvents/${crisis.crisisId}`)
      .get();
    expect(doc.data()).toMatchObject({
      status: 'open',
      familyHarmSuspected: true,
      detection: { familyHarmStatus: 'unknown' },
    });
    const second = runtime.executorFor(child, other.id, []);
    const otherCtx = { ...ctx, sessionId: other.id };
    await expect(second.getChildContext(otherCtx)).rejects.toThrow('safety mode');
    await expect(second.remember(otherCtx, 'すきなこと', 'like')).rejects.toThrow('safety mode');
    await expect(second.startTellAdult(otherCtx)).rejects.toThrow('safety mode');
    expect(await first.escalateCrisis(ctx, 'violence')).toEqual(crisis);
  });

  it('persists HTTP tool budgets across requests while leaving help available', async () => {
    const app = createApp(async () => runtime);
    const childId = 'c_http_budget';
    const s = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const post = async (name: string, args: unknown) => {
      const response = await app.request(`/internal/tools/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childId, sessionId: s.id, operationId: 'turn1', args }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    await post('recall', { topic: '学校' });
    await post('recall', { topic: '学校' });
    await post('recall', { topic: '友達' });
    await post('recall', { topic: 'おうち' });
    expect(await post('record_mood', { weather: 'rainy' })).toEqual({
      result: { error: 'tool_budget_exhausted' },
    });
    expect(await post('show_help_resources', {})).toMatchObject({ result: { ok: true } });
    expect(await post('start_tell_adult', {})).toMatchObject({
      result: { consultationId: expect.any(String) },
    });
  });

  it('replaces tool provider errors before they reach HTTP error logging', async () => {
    const childId = 'c_provider_error';
    const s = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const app = createApp(async () => ({
      ...runtime,
      executorFor: (...args) => ({
        ...runtime.executorFor(...args),
        searchSkill: async () => {
          throw new Error('provider echoed private child text');
        },
      }),
    }));
    const response = await app.request('/internal/tools/search_skill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId, sessionId: s.id, args: { query: '気持ち' } }),
    });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('tool_execution_failed');
    expect(body).not.toContain('private child text');
  });

  it('hydrates care and only an approved, unexpired summary without leaking risk or raw quotes', async () => {
    const childId = 'c_context';
    const s = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const child = (await runtime.directory.lookup(childId))!;
    const ref = db.doc(`families/${child.familyId}/children/${childId}`);
    const ctx = {
      childId,
      sessionId: s.id,
      gradeBand: child.gradeBand,
      characterId: child.characterId,
    };
    const executor = runtime.executorFor(child, s.id, []);
    await ref.update({
      careFlag: true,
      currentRiskLevel: 'l2',
      recentTrend: 'unapproved raw quote',
      agentSummary: {
        text: 'approved aggregate',
        approved: true,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const status = await executor.getChildContext(ctx);
    expect(status).toMatchObject({ careFlag: true, recentTrend: 'approved aggregate' });
    expect(JSON.stringify(status)).not.toMatch(/l2|raw quote/);
    await ref.update({ 'agentSummary.expiresAt': new Date(0) });
    expect((await executor.getChildContext(ctx)).recentTrend).toBe('');
    await ref.collection('weeklyReports').doc('week').set({
      generatedAt: new Date(),
      summaryText: '今週はあまり使いませんでした。',
    });
    expect((await executor.getChildContext(ctx)).recentTrend).toBe(
      '今週はあまり使いませんでした。',
    );
    await ref
      .collection('weeklyReports')
      .doc('week')
      .update({ summaryText: 'unapproved raw quote' });
    expect((await executor.getChildContext(ctx)).recentTrend).toBe('');
  });

  it('publishes only IDs after a committed mood write and republishes the same ID on retries', async () => {
    const childId = 'c_mood_publish';
    const s = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const child = (await runtime.directory.lookup(childId))!;
    const base = `families/${child.familyId}/children/${childId}`;
    await db.doc(base).update({ 'dataSources.typing': false });
    await sessions.writeChildMessage(childId, s.id, {
      text: 'private child words',
      inputMode: 'typed',
      crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
    });
    const events: { topic: string; payload: Record<string, unknown> }[] = [];
    let failPublish = true;
    const publish: Publisher['publish'] = async (topic, payload) => {
      expect(topic).toBe('checkin.created');
      const event = eventSchemas['checkin.created'].parse(payload);
      expect((await db.doc(`${base}/moodCheckins/${event.checkinId}`).get()).exists).toBe(true);
      events.push({ topic, payload });
      if (failPublish) {
        failPublish = false;
        throw new Error('provider echoed private child words');
      }
    };
    const configured = await createRuntime({
      kb: runtime.kb,
      db,
      directory: runtime.directory,
      sessions,
      model: runtime.model,
      logger: runtime.logger,
      publish,
    });
    const executor = configured.executorFor(child, s.id, []);
    const ctx = {
      childId,
      sessionId: s.id,
      gradeBand: child.gradeBand,
      characterId: child.characterId,
      operationId: 'mood_turn1',
    };
    await expect(executor.recordMood(ctx, 'rainy')).rejects.toThrow('checkin_publish_failed');
    expect((await db.collection(`${base}/moodCheckins`).get()).size).toBe(1);
    await executor.recordMood(ctx, 'rainy');
    await executor.recordMood(ctx, 'rainy');
    const checkins = await db.collection(`${base}/moodCheckins`).get();
    expect(checkins.size).toBe(1);
    expect(events).toEqual(
      Array.from({ length: 3 }, () => ({
        topic: 'checkin.created',
        payload: {
          childId,
          kind: 'mood',
          checkinId: checkins.docs[0]!.id,
        },
      })),
    );
    expect(JSON.stringify(events)).not.toMatch(/private child words|rainy|weather|content/);
  });

  it('does not write or publish voice-derived mood after voice consent is disabled', async () => {
    const childId = 'c_voice_mood_disabled';
    const s = await sessions.createSession({
      appName: PET_APP_NAME,
      userId: childId,
      state: { channel: 'voice' },
    });
    const child = (await runtime.directory.lookup(childId))!;
    const base = `families/${child.familyId}/children/${childId}`;
    await db.doc(base).update({ 'dataSources.voice': false });
    let publications = 0;
    const executor = createExecutor({
      db,
      kb: runtime.kb,
      sessions,
      child,
      sessionId: s.id,
      logger: runtime.logger,
      searchSkill: async () => [],
      publish: async () => {
        publications += 1;
      },
    });
    const ctx = {
      childId,
      sessionId: s.id,
      gradeBand: child.gradeBand,
      characterId: child.characterId,
      operationId: 'mood_turn1',
    };
    await expect(executor.recordMood(ctx, 'rainy')).rejects.toMatchObject({
      code: 'DATA_SOURCE_DISABLED',
    });
    expect((await db.collection(`${base}/moodCheckins`).get()).empty).toBe(true);
    expect(publications).toBe(0);
  });
});
