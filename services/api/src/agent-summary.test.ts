import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory } from '@ijime/agent-core';
import type { AgentSummaryRes } from '@ijime/api-types';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createApiRuntime } from './runtime.js';
import type { ChatDeps } from './chat.js';

let db: Firestore;
let directory: DevChildDirectory;
let deps: ChatDeps;
let app: ReturnType<typeof createApp>;
const logs: string[] = [];
const privateText = '最近は 絵のこと の 話を している。';

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('requires emulator');
  db = new Firestore({ projectId: `demo-summary-${Date.now()}` });
  directory = new DevChildDirectory(db);
  const kb = await Kb.load(new FsKbSource(resolve('../../kb/v0.1.0')));
  deps = (
    await createApiRuntime({
      db,
      directory,
      kb,
      auth: { allowDevHeader: true },
      logger: new Logger('summary-test', (line) => logs.push(line)),
    })
  ).chat;
  app = createApp({ getKb: async () => kb, allowedOrigins: [], chat: async () => deps });
});
afterAll(async () => {
  await db?.terminate();
});

async function seed(extra: Record<string, unknown> = {}) {
  const childId = `summary_${randomUUID().replaceAll('-', '')}`;
  const child = (await directory.lookup(childId))!;
  const base = `families/${child.familyId}/children/${childId}`;
  const summary = {
    textEnc: deps.sessions.encryptForChild(child, privateText, `${base}#agentSummary.textEnc`),
    petId: child.petId,
    approved: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...extra,
  };
  await db.doc(base).update({ agentSummary: summary });
  const request = (path = '', body?: unknown) =>
    app.request(`/v1/child/agent-summary${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Dev-Child-Id': childId, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { base, child, summary, request };
}

describe('child-only summary approval', () => {
  it('requires child authentication; approving keeps the same encrypted text', async () => {
    expect((await app.request('/v1/child/agent-summary')).status).toBe(401);
    const o = await seed();
    const read = await o.request();
    expect(read.headers.get('cache-control')).toBe('no-store');
    const body = (await read.json()) as AgentSummaryRes;
    expect(body.summary).toMatchObject({ text: privateText, approved: false });
    const decision = { version: body.summary!.version, decision: 'accept' };
    expect((await o.request('/decision', decision)).status).toBe(204);
    expect((await o.request('/decision', decision)).status).toBe(204);
    const saved = (await db.doc(o.base).get()).get('agentSummary');
    expect(saved.approved).toBe(true);
    expect(Buffer.from(saved.textEnc)).toEqual(o.summary.textEnc);
    expect(JSON.stringify(saved)).not.toContain(privateText);
  });

  it('rejects another child version and replacement races', async () => {
    const a = await seed();
    const b = await seed();
    const read = await a.request();
    const body = (await read.json()) as AgentSummaryRes;
    const decision = { version: body.summary!.version, decision: 'accept' };
    expect((await b.request('/decision', decision)).status).toBe(409);
    await db.doc(a.base).update({
      'agentSummary.textEnc': deps.sessions.encryptForChild(
        a.child,
        'あたらしい 話',
        `${a.base}#agentSummary.textEnc`,
      ),
    });
    expect((await a.request('/decision', decision)).status).toBe(409);
    expect((await db.doc(a.base).get()).get('agentSummary.approved')).toBe(false);
  });

  it('forgets the summary and prevents stale decisions from restoring it', async () => {
    const o = await seed();
    const body = (await (await o.request()).json()) as AgentSummaryRes;
    expect(
      (await o.request('/decision', { version: body.summary!.version, decision: 'reject' })).status,
    ).toBe(204);
    expect(await (await o.request()).json()).toEqual({ summary: null });
    const owner = await db.doc(o.base).get();
    expect(owner.get('modelHistoryResetAt')).toBeDefined();
    expect(owner.get('memoryRevision')).toBe(1);
    expect(
      (await o.request('/decision', { version: body.summary!.version, decision: 'accept' })).status,
    ).toBe(409);
  });

  it.each([{ expiresAt: new Date(0) }, { petId: 'previous-pet' }])(
    'hides expired or previous-pet summaries',
    async (extra) => {
      const o = await seed(extra);
      expect(await (await o.request()).json()).toEqual({ summary: null });
      expect(
        (await o.request('/decision', { version: '0'.repeat(64), decision: 'accept' })).status,
      ).toBe(409);
    },
  );

  it.each(['forget-summary', 'switch-pet'] as const)(
    'hides a persisted proactive greeting on home after %s',
    async (change) => {
      const o = await seed({ approved: true });
      const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
      await db.doc(`${o.base}/proactiveTurns/${today}-morning`).set({
        localDate: today,
        createdAt: new Date(),
        greeting: { text: privateText, expression: 'caring' },
        fallback: false,
        petId: o.child.petId,
        memoryRevision: 0,
        modelHistoryResetAt: null,
      });
      const home = () =>
        app.request('/v1/child/home', { headers: { 'X-Dev-Child-Id': o.child.childId } });
      expect(await (await home()).json()).toMatchObject({
        greeting: { text: privateText, source: 'agent' },
      });
      if (change === 'forget-summary') {
        const body = (await (await o.request()).json()) as AgentSummaryRes;
        expect(
          (await o.request('/decision', { version: body.summary!.version, decision: 'reject' }))
            .status,
        ).toBe(204);
      } else {
        expect(
          (
            await app.request('/v1/child/pets', {
              method: 'POST',
              headers: {
                'X-Dev-Child-Id': o.child.childId,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ characterId: 'pokke' }),
            })
          ).status,
        ).toBe(201);
      }
      const response = await home();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ greeting: { source: 'template' } });
      expect(JSON.stringify(body)).not.toContain(privateText);
    },
  );

  it('does not show legacy proactive greetings without a context version', async () => {
    const o = await seed();
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    await db.doc(`${o.base}/proactiveTurns/${today}-morning`).set({
      localDate: today,
      createdAt: new Date(),
      greeting: { text: privateText, expression: 'caring' },
      fallback: false,
    });
    const response = await app.request('/v1/child/home', {
      headers: { 'X-Dev-Child-Id': o.child.childId },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ greeting: { source: 'template' } });
  });

  it('does not leak summary text to logs', () => {
    expect(logs.join('\n')).not.toContain(privateText);
  });
});
