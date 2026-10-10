import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  PET_APP_NAME,
  ScriptedLlm,
} from '@ijime/agent-core';
import {
  CrisisDetector,
  KeywordMatcher,
  ModelCallError,
  type ReviewResult,
} from '@ijime/crisis-detector';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { CRISIS_RECHECK_PATH, Logger, MemoryPublisher, stableId } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SENTINEL = 'SENTINEL_ほりかえし';

let db: Firestore;
let kb: Kb;
let directory: DevChildDirectory;
let sessions: FirestoreSessionService;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  kb = await Kb.load(new FsKbSource(KB_DIR));
  directory = new DevChildDirectory(db);
  sessions = new FirestoreSessionService(db, directory);
});
afterAll(() => db.terminate());

type Review = ReviewResult | 'down';

function setup(review: Review) {
  const lines: string[] = [];
  const logger = new Logger('signal-worker', (l) => lines.push(l));
  const publisher = new MemoryPublisher();
  const calls = { review: 0 };
  const detector = new CrisisDetector(
    new KeywordMatcher(['きえたい']),
    { screen: async () => ({ suspect: true }) },
    {
      review: async () => {
        calls.review++;
        if (review === 'down') throw new ModelCallError('error');
        return review;
      },
    },
  );
  const llm = new ScriptedLlm(() => ({ text: '{}' }), { model: 'unused' });
  const app = createApp(
    async () => ({
      db,
      kb,
      sessions,
      directory,
      publisher,
      model: llm,
      artworkModel: llm,
      detector,
      logger,
      now: () => new Date('2026-10-05T03:00:00Z'),
    }),
    logger,
  );
  const post = (body: unknown) =>
    app.request(CRISIS_RECHECK_PATH, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  return { lines, publisher, calls, post };
}

async function seedPaused(childId: string, text: string, pendingReview = true) {
  const child = await directory.lookup(childId);
  const session = await sessions.createSession({
    appName: PET_APP_NAME,
    userId: childId,
    state: { channel: 'text' },
  });
  const { messageId } = await sessions.writeChildMessage(childId, session.id, {
    text,
    inputMode: 'typed',
    crisisCheck: { hit: false, method: 'paused', score: 0, checkedAt: new Date(), pendingReview },
  });
  const task = {
    familyId: child.familyId,
    childId,
    sessionId: session.id,
    messageId,
    channel: 'text' as const,
  };
  const base = `families/${child.familyId}/children/${childId}`;
  return {
    task,
    base,
    messageRef: db.doc(`${base}/sessions/${session.id}/messages/${messageId}`),
    sessionRef: db.doc(`${base}/sessions/${session.id}`),
    crisisRef: db.doc(`${base}/crisisEvents/recheck_${stableId(session.id, messageId)}`),
  };
}

const CLEAR: ReviewResult = { hit: false, category: 'none', confidence: 0.1 };

describe('crisis recheck task', () => {
  it('clear result releases the message to the pet context and signal extraction', async () => {
    const s = await seedPaused('c_rc_clear', `きょうはねむい ${SENTINEL}`);
    const t = setup(CLEAR);
    expect((await t.post(s.task)).status).toBe(204);

    const msg = (await s.messageRef.get()).data()!;
    expect(msg['crisisCheck']).toMatchObject({
      hit: false,
      method: 'screen',
      pendingReview: false,
    });
    expect(msg['crisisCheck'].recheckedAt).toBeDefined();
    expect(t.publisher.of('message.created')).toEqual([s.task]);
    expect(t.publisher.of('crisis.detected')).toEqual([]);
    expect((await s.crisisRef.get()).exists).toBe(false);
    expect((await s.sessionRef.get()).get('safeMode')).toBe(false);

    const session = await sessions.getSession({
      appName: PET_APP_NAME,
      userId: 'c_rc_clear',
      sessionId: s.task.sessionId,
    });
    expect(session!.events.some((e) => e.id === s.task.messageId)).toBe(true);

    // 再投入：再審査済みなので、モデルを呼び出さずイベントも再発行しない
    expect((await t.post(s.task)).status).toBe(204);
    expect(t.calls.review).toBe(1);
    expect(t.publisher.of('message.created')).toHaveLength(1);
    expect([...t.lines, JSON.stringify(t.publisher.published)].join('\n')).not.toContain(SENTINEL);
  });

  it('a hit on recheck opens a delayed crisis, marks safe mode, and notifies', async () => {
    const text = `もう学校にいきたくない、しんでしまいたい ${SENTINEL}`;
    const s = await seedPaused('c_rc_hit', text);
    const t = setup({
      hit: true,
      category: 'self_harm',
      confidence: 0.9,
      evidenceSpan: 'しんでしまいたい',
    });
    expect((await t.post(s.task)).status).toBe(204);

    const crisis = (await s.crisisRef.get()).data()!;
    expect(crisis).toMatchObject({
      triggerType: 'text',
      sourceRef: s.messageRef.path,
      category: 'self_harm',
      familyHarmSuspected: false,
      status: 'open',
      detection: { method: 'review', delayed: true },
    });
    expect(crisis['timeline'][0].step).toBe('detected_on_recheck');
    expect((await s.sessionRef.get()).get('safeMode')).toBe(true);
    expect(t.publisher.of('crisis.detected')).toEqual([
      {
        childId: 'c_rc_hit',
        crisisId: s.crisisRef.id,
        category: 'self_harm',
        familyHarmSuspected: false,
        delayed: true,
      },
    ]);
    expect(t.publisher.of('message.created')).toEqual([s.task]);
    expect((await s.messageRef.get()).get('crisisCheck')).toMatchObject({
      hit: true,
      pendingReview: false,
    });
    expect(
      [...t.lines, JSON.stringify(t.publisher.published), JSON.stringify(crisis)].join('\n'),
    ).not.toContain(SENTINEL);
  });

  it('models still down: the task fails for a Cloud Tasks retry and nothing is released', async () => {
    const s = await seedPaused('c_rc_down', `ふつうのはなし ${SENTINEL}`);
    const t = setup('down');
    expect((await t.post(s.task)).status).toBe(503);
    expect((await s.messageRef.get()).get('crisisCheck.pendingReview')).toBe(true);
    expect(t.publisher.published).toEqual([]);
    expect(t.lines.join('\n')).toContain('crisis.recheck_paused');
  });

  it('retry after a partial failure reuses the stored crisis without asking the model again', async () => {
    const s = await seedPaused('c_rc_retry', 'なにか');
    await s.crisisRef.set({
      category: 'violence',
      familyHarmSuspected: false,
      detection: { method: 'review', confidence: 0.8, delayed: true },
      status: 'open',
    });
    const t = setup(CLEAR);
    expect((await t.post(s.task)).status).toBe(204);
    expect(t.calls.review).toBe(0);
    expect(t.publisher.of('crisis.detected')).toEqual([
      {
        childId: 'c_rc_retry',
        crisisId: s.crisisRef.id,
        category: 'violence',
        familyHarmSuspected: false,
        delayed: true,
      },
    ]);
    expect((await s.messageRef.get()).get('crisisCheck')).toMatchObject({
      hit: true,
      pendingReview: false,
    });
  });

  it('skips messages that are not waiting for review', async () => {
    const s = await seedPaused('c_rc_skip', 'ふつう', false);
    const t = setup(CLEAR);
    expect((await t.post(s.task)).status).toBe(204);
    expect(t.calls.review).toBe(0);
    expect(t.publisher.published).toEqual([]);
  });

  it('drops malformed tasks without retry', async () => {
    const t = setup(CLEAR);
    expect((await t.post({ childId: 'x' })).status).toBe(204);
    expect(t.calls.review).toBe(0);
  });
});
