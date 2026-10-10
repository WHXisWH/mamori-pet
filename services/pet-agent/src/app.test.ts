import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  PET_APP_NAME,
  petDemoScript,
  ScriptedLlm,
} from '@ijime/agent-core';
import type { PetAction, TurnChunk } from '@ijime/api-types';
import { FsKbSource, Kb, loadQuickReplyCatalog, openingsSchema } from '@ijime/kb-loader';
import { Logger, eventSchemas, type Publisher } from '@ijime/service-kit';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp, SERVICE_NAME } from './app.js';
import { buildAgent, createRuntime, type PetRuntime } from './runtime.js';
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

beforeEach(({ task }) => {
  if (!task.name.includes('proactive')) return;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T06:00:00Z'));
});
afterEach(() => vi.useRealTimers());

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
  it('keeps declined games out of requests and budget until an explicit change of mind', async () => {
    const childId = `c_game_${randomUUID()}`;
    const s = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const base = `families/f_dev_${childId}/children/${childId}`;
    const model = new ScriptedLlm(({ toolResults }) =>
      toolResults.length
        ? { text: 'もこの しまの そらは、あおいよ。' }
        : { calls: [{ name: 'suggest_game', args: { type: 'drawing' } }] },
    );
    const app = createApp(async () => ({ ...runtime, model }));
    const send = async (text: string) => {
      const { messageId } = await sessions.writeChildMessage(childId, s.id, {
        text,
        inputMode: 'typed',
        crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
      });
      const response = await app.request('/internal/turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childId, sessionId: s.id, messageId }),
      });
      expect(response.status).toBe(200);
      const chunks = (await response.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as TurnChunk);
      expect(
        chunks
          .filter((c) => c.type === 'delta')
          .map((c) => c.text)
          .join(''),
      ).toBe('もこの しまの そらは、あおいよ。');
      expect(chunks.at(-1)?.type).toBe('done');
      return chunks;
    };
    for (const text of [
      'あそびにも いきたくない。',
      'べつの はなしをしたい',
      'そらは なにいろ？',
    ]) {
      const chunks = await send(text);
      expect(chunks.some((c) => c.type === 'action' && c.action.type === 'suggest_game')).toBe(
        false,
      );
      expect((await db.collection(`${base}/petRequests`).get()).empty).toBe(true);
      expect((await db.doc(`${base}/toolUsage/suggest_game`).get()).exists).toBe(false);
    }
    expect(
      (await db.doc(`${base}/sessions/${s.id}`).get()).get('adkState.gameSuggestionsDeclined'),
    ).toBe(true);
    const changed = await send('いまは ゲームで あそびたい。');
    expect(changed.some((c) => c.type === 'action' && c.action.type === 'suggest_game')).toBe(true);
    expect((await db.collection(`${base}/petRequests`).get()).size).toBe(1);
    expect((await db.doc(`${base}/toolUsage/suggest_game`).get()).get('timestamps')).toHaveLength(
      1,
    );
    expect(
      (await db.doc(`${base}/sessions/${s.id}`).get()).get('adkState.gameSuggestionsDeclined'),
    ).toBe(false);
  });

  it('answers /healthz', async () => {
    const res = await createApp(async () => runtime).request('/healthz');
    expect(await res.json()).toMatchObject({ status: 'ok', service: SERVICE_NAME });
  });

  it('runs one idempotent proactive turn and stores the greeting for the child home', async () => {
    const app = createApp(async () => runtime);
    const body = { childId: 'c_proactive', slot: 'morning', localDate: '2026-10-06' };
    const first = await app.request('/internal/proactive-turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    const saved = (await first.json()) as {
      greeting: { text: string; expression: string };
      fallback: boolean;
    };
    expect(saved.greeting.text.length).toBeGreaterThan(0);
    expect(saved.greeting.expression).toBe('together');
    expect(saved.fallback).toBe(false);

    const second = await app.request('/internal/proactive-turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(saved);
    const stored = await db
      .doc('families/f_dev_c_proactive/children/c_proactive/proactiveTurns/2026-10-06-morning')
      .get();
    expect(stored.get('localDate')).toBe('2026-10-06');
    expect(stored.get('greeting.text')).toBe(saved.greeting.text);
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

  it('proactive turns expose only three tools and do not read or store chat messages', async () => {
    const model = new ScriptedLlm(() => ({ text: 'きょうも あえて うれしいよ。' }));
    const app = createApp(async () => ({ ...runtime, model }));
    const history = vi.spyOn(sessions, 'getSession');
    try {
      const res = await app.request('/internal/proactive-turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          childId: 'c_proactive_private',
          localDate: '2026-10-06',
          slot: 'after_school',
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ fallback: false });
      const names = model.requests[0]!.config?.tools?.flatMap((tool) =>
        'functionDeclarations' in tool
          ? (tool.functionDeclarations?.map((fn) => fn.name) ?? [])
          : [],
      );
      expect(names?.sort()).toEqual(['recall', 'set_expression', 'suggest_game']);
      expect(history).not.toHaveBeenCalled();
      const base = 'families/f_dev_c_proactive_private/children/c_proactive_private';
      expect(
        (await db.collection(`${base}/sessions/proactive-2026-10-06-after_school/messages`).get())
          .empty,
      ).toBe(true);
    } finally {
      history.mockRestore();
    }
  });

  it.each(['remember', 'start_tell_adult', 'escalate_crisis'])(
    'proactive model cannot execute %s',
    async (name) => {
      const childId = `c_forbidden_${name}`;
      const args =
        name === 'remember'
          ? { content: 'ひみつ', category: 'other' }
          : name === 'escalate_crisis'
            ? { category: 'self_harm' }
            : {};
      const model = new ScriptedLlm(() => ({ calls: [{ name, args }] }));
      const app = createApp(async () => ({ ...runtime, model }));
      const res = await app.request('/internal/proactive-turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childId, localDate: '2026-10-06', slot: 'morning' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ fallback: true });
      for (const collection of ['memoryProposals', 'consultations', 'crisisEvents']) {
        expect(
          (await db.collection(`families/f_dev_${childId}/children/${childId}/${collection}`).get())
            .empty,
        ).toBe(true);
      }
    },
  );

  it('model errors return and persist a KB opening instead of a failed proactive task', async () => {
    const model = new ScriptedLlm(() => {
      throw new Error('synthetic model outage');
    });
    const app = createApp(async () => ({ ...runtime, model }));
    const res = await app.request('/internal/proactive-turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        childId: 'c_proactive_outage',
        localDate: '2026-10-06',
        slot: 'morning',
      }),
    });
    expect(res.status).toBe(200);
    const { openings } = await runtime.kb.yaml('prompts/openings.yaml', openingsSchema);
    const child = (await runtime.directory.lookup('c_proactive_outage'))!;
    expect(await res.json()).toEqual({
      greeting: { text: openings[child.gradeBand][0], expression: 'caring' },
      fallback: true,
    });
  });

  it('the agent chooses tools: start_tell_adult writes a consultation and emits offer_tell_adult', async () => {
    const { chunks } = await turn('c_pa2', 'おとなに はなしたい');
    const offer = chunks.find((c) => c.type === 'action' && c.action.type === 'offer_tell_adult');
    const child = (await runtime.directory.lookup('c_pa2'))!;
    const openingLine = (await runtime.kb.text(`templates/coaching/${child.gradeBand}.ja.txt`))
      .split('\n')[0]!
      .trim();
    expect(offer).toMatchObject({ action: { type: 'offer_tell_adult', openingLine } });
    const consultations = await db
      .collection('families/f_dev_c_pa2/children/c_pa2/consultations')
      .get();
    expect(consultations.size).toBe(1);
    expect(consultations.docs[0]?.data()['source']).toBe('child_initiated');
  });

  it.each([
    { name: 'unfinished child followup', patch: {}, restore: true },
    { name: 'same offer also returned by a real tool', patch: {}, restore: true, callsTool: true },
    { name: 'risk engine offer', patch: { source: 'risk_engine' }, restore: false },
    { name: 'ordinary child offer', patch: { source: 'child_initiated' }, restore: false },
    { name: 'not now', patch: { choice: 'not_now' }, restore: false },
    { name: 'self chosen', patch: { choice: 'self' }, restore: false },
    { name: 'proxy chosen', patch: { choice: 'proxy' }, restore: false },
    { name: 'paused', patch: { followUpState: 'paused' }, restore: false },
    { name: 'closed', patch: { closedAt: new Date() }, restore: false },
    { name: 'family harm', patch: { familyHarmSuspected: true }, restore: false },
  ])(
    'restores only an explicitly requested unfinished flow: $name',
    async ({ patch, restore, callsTool }) => {
      const childId = `c_restore_${randomUUID()}`;
      const child = (await runtime.directory.lookup(childId))!;
      const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
      const path = `families/${child.familyId}/children/${childId}/consultations/unfinished`;
      const saved = {
        source: 'child_followup',
        followUpReason: 'need_help',
        assessmentId: 'child-followup',
        level: 'l2',
        offeredAt: new Date(),
        offerCount: 1,
        ...patch,
      };
      await db.doc(path).set(saved);
      const before = (await db.doc(path).get()).data();
      const model = new ScriptedLlm(({ toolResults }) =>
        callsTool && toolResults.length === 0
          ? { calls: [{ name: 'start_tell_adult', args: {} }] }
          : { text: 'ここに いるよ。' },
      );
      const { messageId } = await sessions.writeChildMessage(childId, session.id, {
        text: 'きいていてね',
        inputMode: 'typed',
        crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
      });
      const res = await createApp(async () => ({ ...runtime, model })).request('/internal/turns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childId, sessionId: session.id, messageId }),
      });
      expect(res.status).toBe(200);
      const chunks = (await res.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as TurnChunk);
      const offers = chunks.filter(
        (chunk) => chunk.type === 'action' && chunk.action.type === 'offer_tell_adult',
      );
      expect(offers).toHaveLength(restore ? 1 : 0);
      if (restore)
        expect(offers[0]).toMatchObject({
          action: {
            consultationId: 'unfinished',
            source: 'restored_followup',
            openingLine: expect.any(String),
          },
        });
      expect((await db.doc(path).get()).data()).toEqual(before);
      expect((await db.collection(`families/${child.familyId}/notifications`).get()).empty).toBe(
        true,
      );
      const proactiveActions: PetAction[] = [];
      await buildAgent(
        { ...runtime, model },
        child,
        session.id,
        proactiveActions,
        undefined,
        messageId,
        '',
        true,
      );
      expect(proactiveActions).toEqual([]);
    },
  );

  it('pseudonymizes model and HTTP memory proposals before storage or child-visible actions', async () => {
    const text = '田中くんと絵を描くのが好き';
    const model = new ScriptedLlm(({ toolResults }) =>
      toolResults.length
        ? { text: 'おぼえておいても いいかな？' }
        : { calls: [{ name: 'remember', args: { content: text, category: 'person' } }] },
    );
    const childId = 'c_pa_peer_names';
    const child = (await runtime.directory.lookup(childId))!;
    const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const { messageId } = await sessions.writeChildMessage(childId, session.id, {
      text,
      inputMode: 'typed',
      crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
    });
    const app = createApp(async () => ({ ...runtime, model }));
    const response = await app.request('/internal/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId, sessionId: session.id, messageId }),
    });
    const output = await response.text();
    expect(output).toContain('memory_proposal');
    expect(output).toContain('おともだちA');
    expect(output).not.toContain('田中');
    const direct = await app.request('/internal/tools/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        childId,
        sessionId: session.id,
        operationId: 'http-remember',
        args: { content: text, category: 'person' },
      }),
    });
    expect(direct.status).toBe(200);
    const directOutput = await direct.text();
    expect(directOutput).toContain('おともだちA');
    expect(directOutput).not.toContain('田中');
    const path = `families/${child.familyId}/children/${childId}/memoryProposals`;
    const proposals = await db.collection(path).get();
    expect(proposals.size).toBe(2);
    for (const doc of proposals.docs) {
      const content = sessions.decryptForChild(
        child,
        Buffer.from(doc.get('contentEnc')),
        `${path}#contentEnc`,
      );
      expect(content).toContain('おともだちA');
      expect(content).not.toContain('田中');
    }
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
      detection: { source: 'agent_tool', category: 'self_harm' },
      category: 'self_harm',
      familyHarmSuspected: false,
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

  it('renders catalog-backed quick replies through the internal tool endpoint', async () => {
    const childId = `c_quick_${randomUUID()}`;
    const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const app = createApp(async () => runtime);
    const post = (args: unknown) =>
      app.request('/internal/tools/offer_quick_replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ childId, sessionId: session.id, args }),
      });
    const child = await runtime.directory.lookup(childId);
    const catalog = await loadQuickReplyCatalog(runtime.kb);
    const options = [catalog[child!.gradeBand].listen_only, catalog[child!.gradeBand].pause];
    expect(await (await post({ intents: ['listen_only', 'pause'] })).json()).toEqual({
      result: { error: 'quick_reply_trigger_required' },
      actions: [],
    });
    await sessions.writeChildMessage(childId, session.id, {
      text: '返事に迷っているので、候補を見せて。',
      inputMode: 'typed',
      crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
    });
    const response = await post({
      intents: ['listen_only', 'pause'],
      trigger: { kind: 'requested', evidenceSpan: '候補を見せて' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: { ok: true, options },
      actions: [{ type: 'quick_replies', options }],
    });
    await sessions.writeChildMessage(childId, session.id, {
      text: '候補を見せて',
      inputMode: 'typed',
      crisisCheck: {
        hit: false,
        method: 'paused',
        score: 0,
        checkedAt: new Date(),
        pendingReview: true,
      },
    });
    const pending = await post({
      intents: ['listen_only', 'pause'],
      trigger: { kind: 'requested', evidenceSpan: '候補を見せて' },
    });
    expect(await pending.json()).toEqual({
      result: { error: 'quick_reply_trigger_required' },
      actions: [],
    });
    expect((await post({ options: ['きいてあげる', 'もう解決した'] })).status).toBe(400);
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

  it.each(['low', 'high'] as const)(
    'grounds help in the %s coaching first line only after committing, without storing it',
    async (gradeBand) => {
      const childId = `grounding_${randomUUID()}`;
      const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
      const child = (await runtime.directory.lookup(childId))!;
      const base = `families/${child.familyId}/children/${childId}`;
      const text = vi.fn(async (path: string) => {
        expect((await db.collection(`${base}/consultations`).get()).size).toBe(1);
        return runtime.kb.text(path);
      });
      const executor = createExecutor({
        db,
        kb: { text } as unknown as Kb,
        sessions,
        child,
        sessionId: session.id,
        searchSkill: async () => [],
        logger: runtime.logger,
        publish: runtime.publish,
      });
      const ctx = { childId, sessionId: session.id, gradeBand, characterId: child.characterId };
      const firstLine = (await runtime.kb.text(`templates/coaching/${gradeBand}.ja.txt`))
        .split('\n')[0]!
        .trim();
      expect(firstLine).not.toBe('');
      const result = await executor.startTellAdult(ctx);
      expect(result).toMatchObject({ openingLine: firstLine });
      expect(await executor.startTellAdult(ctx)).toEqual(result);
      expect(text).toHaveBeenCalledWith(`templates/coaching/${gradeBand}.ja.txt`);
      expect(
        (await db.doc(`${base}/consultations/${result.consultationId}`).get()).get('openingLine'),
      ).toBeUndefined();
      const receipts = await db.collection(`${base}/sessions/${session.id}/toolReceipts`).get();
      expect(receipts.size).toBe(1);
      expect(receipts.docs[0]!.get('result')).toEqual({ consultationId: result.consultationId });
    },
  );

  it.each(['', '  \r\nsecond line must not become an opening'])(
    'omits an empty coaching first line: %j',
    async (template) => {
      const childId = `empty_opening_${randomUUID()}`;
      const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
      const child = (await runtime.directory.lookup(childId))!;
      const text = vi.fn(async () => template);
      const executor = createExecutor({
        db,
        kb: { text } as unknown as Kb,
        sessions,
        child,
        sessionId: session.id,
        searchSkill: async () => [],
        logger: runtime.logger,
        publish: runtime.publish,
      });
      const result = await executor.startTellAdult({
        childId,
        sessionId: session.id,
        gradeBand: child.gradeBand,
        characterId: child.characterId,
      });
      expect(result).toEqual({ consultationId: expect.any(String) });
      expect(text).toHaveBeenCalledOnce();
    },
  );

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
    expect(await executor.startTellAdult(ctx)).toMatchObject({ consultationId: 'due' });
    expect(await executor.startTellAdult(ctx)).toMatchObject({ consultationId: 'due' });
    expect((await db.doc(`${base}/consultations/due`).get()).data()).toMatchObject({
      offerCount: 2,
    });
    expect((await db.doc(`${base}/consultations/due`).get()).get('choice')).toBeUndefined();
    expect((await db.doc(base).get()).get('currentRiskLevel')).toBe('l0');
  });

  it.each([false, true])(
    'resumes early not_now only on the child request, retaining the ID and round (%s)',
    async (postponed) => {
      const childId = `resume_${randomUUID()}`;
      const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
      const child = (await runtime.directory.lookup(childId))!;
      const base = `families/${child.familyId}/children/${childId}`;
      const ref = db.doc(`${base}/consultations/later`);
      await ref.set({
        level: 'l2',
        choice: 'not_now',
        offerCount: 1,
        offeredAt: new Date(),
        choiceAt: new Date(),
        followUpAt: new Date(Date.now() + 3 * 86_400_000),
        ...(postponed
          ? {
              followUpAnswer: 'not_now',
              followUpState: 'later',
              followUpUpdatedAt: new Date(),
              followUpRound: 1,
            }
          : {}),
      });
      const executor = runtime.executorFor(child, session.id, []);
      const ctx = {
        childId,
        sessionId: session.id,
        gradeBand: child.gradeBand,
        characterId: child.characterId,
        operationId: 'ask-again',
      };
      expect((await executor.getChildContext(ctx)).pendingConsultationId).toBeUndefined();
      expect(await executor.startTellAdult(ctx)).toMatchObject({ consultationId: 'later' });
      expect(await executor.startTellAdult(ctx)).toMatchObject({ consultationId: 'later' });
      expect(await executor.startTellAdult({ ...ctx, operationId: 'another-turn' })).toMatchObject({
        consultationId: 'later',
      });
      const stored = (await ref.get()).data()!;
      for (const field of [
        'choice',
        'choiceAt',
        'followUpAt',
        'followUpAnswer',
        'followUpState',
        'followUpUpdatedAt',
      ])
        expect(stored[field]).toBeUndefined();
      expect(stored.offerCount).toBe(2);
      if (postponed) expect(stored.followUpRound).toBe(1);
      expect((await db.collection(`${base}/consultations`).get()).size).toBe(1);
      expect((await executor.getChildContext(ctx)).pendingConsultationId).toBe('later');
    },
  );

  it.each(['supported', 'paused'] as const)(
    'keeps the stopped %s attempt intact when a child asks anew',
    async (state) => {
      const childId = `stopped_${randomUUID()}`;
      const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
      const child = (await runtime.directory.lookup(childId))!;
      const ref = db.doc(`families/${child.familyId}/children/${childId}/consultations/stopped`);
      await ref.set({
        level: 'l2',
        choice: 'not_now',
        offeredAt: new Date(),
        offerCount: 1,
        followUpState: state,
        followUpAnsweredAt: new Date(),
      });
      const before = (await ref.get()).data();
      const executor = runtime.executorFor(child, session.id, []);
      const result = await executor.startTellAdult({
        childId,
        sessionId: session.id,
        gradeBand: child.gradeBand,
        characterId: child.characterId,
      });
      expect(result.consultationId).not.toBe('stopped');
      expect((await ref.get()).data()).toEqual(before);
    },
  );

  it.each(['open', 'guardian_acknowledged'])(
    'does not resume not_now past an unresolved family-harm crisis: %s',
    async (status) => {
      const childId = `unsafe_resume_${randomUUID()}`;
      const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
      const child = (await runtime.directory.lookup(childId))!;
      const base = `families/${child.familyId}/children/${childId}`;
      const ref = db.doc(`${base}/consultations/later`);
      await ref.set({
        level: 'l2',
        choice: 'not_now',
        offeredAt: new Date(),
        offerCount: 1,
        followUpAt: new Date(Date.now() + 86_400_000),
      });
      const before = (await ref.get()).data();
      await db
        .doc(`${base}/crisisEvents/unsafe`)
        .set({ status, familyHarmSuspected: true, createdAt: new Date() });
      const text = vi.fn(async () => '');
      const executor = createExecutor({
        db,
        kb: { text } as unknown as Kb,
        sessions,
        child,
        sessionId: session.id,
        searchSkill: async () => [],
        logger: runtime.logger,
        publish: runtime.publish,
      });
      await expect(
        executor.startTellAdult({
          childId,
          sessionId: session.id,
          gradeBand: child.gradeBand,
          characterId: child.characterId,
        }),
      ).rejects.toThrow('safety mode');
      expect(text).not.toHaveBeenCalled();
      expect((await ref.get()).data()).toEqual(before);
      expect((await db.collection(`${base}/consultations`).get()).size).toBe(1);
    },
  );

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
      category: 'violence',
      familyHarmSuspected: false,
      detection: { source: 'agent_tool', category: 'violence' },
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
        petId: child.petId,
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
