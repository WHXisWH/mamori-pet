import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory } from '@ijime/agent-core';
import type { ChoiceRes } from '@ijime/api-types';
import { consultation as consultConfig } from '@ijime/config';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { careHintDraftId } from './routes/consultations.js';
import { createApiRuntime } from './runtime.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SUMMARY = '学校で無視されてつらい';

let db: Firestore;
let app: ReturnType<typeof createApp>;
let directory: DevChildDirectory;
const published: { topic: string; payload: Record<string, unknown> }[] = [];
const logLines: string[] = [];

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  directory = new DevChildDirectory(db);
  const rt = await createApiRuntime({
    kb,
    db,
    directory,
    logger: new Logger('api', (l) => logLines.push(l)),
    publish: async (topic, payload) => void published.push({ topic, payload }),
    auth: { allowDevHeader: true },
  });
  app = createApp({
    getKb: async () => kb,
    allowedOrigins: ['http://localhost:3000'],
    chat: async () => rt.chat,
  });
});
afterAll(() => db.terminate());
beforeEach(() => {
  published.length = 0;
});

async function seed(childId: string, id: string, level: 'l2' | 'l3') {
  const child = await directory.lookup(childId);
  const path = `families/${child.familyId}/children/${childId}/consultations/${id}`;
  await db.doc(path).set({ assessmentId: 'a1', level, offeredAt: new Date(), offerCount: 1 });
  return { familyId: child.familyId, path };
}

const choose = (childId: string, id: string, body: unknown) =>
  app.request(`/v1/child/consultations/${id}/choice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Dev-Child-Id': childId },
    body: JSON.stringify(body),
  });

describe('POST /v1/child/consultations/:id/choice', () => {
  it('proxy stores the encrypted summary, drafts a care_hint and publishes', async () => {
    const { familyId, path } = await seed('c_cs1', 'cs1', 'l3');
    const res = await choose('c_cs1', 'cs1', {
      choice: 'proxy',
      summary: { text: SUMMARY, confirmed: true },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as ChoiceRes).toEqual({ notificationQueued: true });

    const doc = (await db.doc(path).get()).data()!;
    expect(doc['choice']).toBe('proxy');
    expect(doc['childConfirmedSummary']).toBe(true);
    expect(Buffer.from(doc['summaryEnc']).toString('utf8')).not.toContain(SUMMARY);

    const draft = (
      await db.doc(`families/${familyId}/notifications/${careHintDraftId('c_cs1', 'cs1')}`).get()
    ).data()!;
    expect(draft).toMatchObject({
      childId: 'c_cs1',
      kind: 'care_hint',
      level: 'l3',
      status: 'queued',
      recipientIds: [],
      payload: { childSummary: SUMMARY },
    });
    expect(published).toEqual([
      {
        topic: 'consultation.resolved',
        payload: { childId: 'c_cs1', consultationId: 'cs1', choice: 'proxy' },
      },
    ]);
    expect(logLines.join('\n')).not.toContain(SUMMARY);

    // 重複した送信：保存済みの回答は変更しない。イベントは再送されうる
    expect(
      (await choose('c_cs1', 'cs1', { choice: 'proxy', summary: { text: 'x', confirmed: true } }))
        .status,
    ).toBe(200);
    const again = (await db.doc(path).get()).data()!;
    expect(Buffer.from(again['summaryEnc'])).toEqual(Buffer.from(doc['summaryEnc']));
    expect((await choose('c_cs1', 'cs1', { choice: 'not_now' })).status).toBe(409);
  });

  it('proxy requires a confirmed summary', async () => {
    await seed('c_cs2', 'cs2', 'l3');
    expect((await choose('c_cs2', 'cs2', { choice: 'proxy' })).status).toBe(400);
    expect(
      (
        await choose('c_cs2', 'cs2', {
          choice: 'proxy',
          summary: { text: SUMMARY, confirmed: false },
        })
      ).status,
    ).toBe(400);
    expect(published).toEqual([]);
  });

  it('self returns the coaching script from kb', async () => {
    await seed('c_cs3', 'cs3', 'l2');
    const res = await choose('c_cs3', 'cs3', { choice: 'self' });
    const body = (await res.json()) as ChoiceRes;
    expect(body.notificationQueued).toBe(false);
    expect(body.coachingScript?.length).toBeGreaterThan(0);
    expect(body.coachingScript![0]).toContain('話したい');
  });

  it('L2 not_now schedules a follow-up and queues nothing', async () => {
    const { path } = await seed('c_cs4', 'cs4', 'l2');
    const res = await choose('c_cs4', 'cs4', { choice: 'not_now' });
    expect((await res.json()) as ChoiceRes).toEqual({ notificationQueued: false });
    const doc = (await db.doc(path).get()).data()!;
    const followUp = doc['followUpAt'].toDate().getTime() - doc['choiceAt'].toDate().getTime();
    expect(followUp).toBe(consultConfig.l2FollowUpDays * 86_400_000);
  });

  it('L3 not_now reports that a content-free alert is queued', async () => {
    const { path } = await seed('c_cs5', 'cs5', 'l3');
    const res = await choose('c_cs5', 'cs5', { choice: 'not_now' });
    expect((await res.json()) as ChoiceRes).toEqual({ notificationQueued: true });
    expect((await db.doc(path).get()).data()!['followUpAt']).toBeUndefined();
  });

  it('a crisis in the summary goes to the crisis path and drafts nothing', async () => {
    const { familyId, path } = await seed('c_cs6', 'cs6', 'l3');
    const res = await choose('c_cs6', 'cs6', {
      choice: 'proxy',
      summary: { text: 'もう 消えたい', confirmed: true },
    });
    expect(res.status).toBe(200);
    const doc = (await db.doc(path).get()).data()!;
    expect(doc['summaryEnc']).toBeUndefined();
    expect(doc['crisisId']).toBeTruthy();
    expect(published.map((p) => p.topic)).toEqual(['crisis.detected']);
    const draft = await db
      .doc(`families/${familyId}/notifications/${careHintDraftId('c_cs6', 'cs6')}`)
      .get();
    expect(draft.exists).toBe(false);
  });

  it('unknown consultation is NOT_FOUND', async () => {
    expect((await choose('c_cs7', 'nope', { choice: 'self' })).status).toBe(404);
  });
});
