import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  PET_APP_NAME,
  ScriptedLlm,
} from '@ijime/agent-core';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createRuntime, type PetRuntime } from './runtime.js';
import { readChildContext } from './context.js';

let db: Firestore;
let rt: PetRuntime;
const logs: string[] = [];
const model = new ScriptedLlm(() => ({ text: 'はなしてくれて ありがとう。' }));

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-context-${randomUUID().slice(0, 12)}` });
  const directory = new DevChildDirectory(db);
  rt = await createRuntime({
    db,
    directory,
    model,
    sessions: new FirestoreSessionService(db, directory, { writeUserEvents: false }),
    kb: await Kb.load(
      new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
    ),
    logger: new Logger('memory-context-test', (line) => logs.push(line)),
  });
});

describe('child-owned help continuity', () => {
  const now = new Date('2026-10-07T07:00:00Z');
  const later = new Date('2026-10-09T07:00:00Z');
  async function fixture() {
    const child = (await rt.directory.lookup(`c_${randomUUID()}`))!;
    const base = `families/${child.familyId}/children/${child.childId}`;
    return {
      child,
      base,
      consultations: db.collection(`${base}/consultations`),
      read: () => readChildContext(db, rt.kb, child, now, rt.sessions),
    };
  }

  it.each(['self', 'proxy', 'not_now'])(
    'does not infer a result from the choice %s',
    async (choice) => {
      const f = await fixture();
      expect((await f.read()).helpAttempt).toBeUndefined();
      await f.consultations.doc('attempt').set({
        offeredAt: new Date('2026-10-01'),
        choiceAt: new Date('2026-10-02'),
        choice,
        notificationId: 'sent',
        acknowledgedAt: now,
        followUpAt: later,
      });
      expect((await f.read()).helpAttempt).toEqual({
        choice,
        state: 'unknown',
        followUp: 'scheduled',
      });
      await f.consultations.doc('attempt').update({ followUpAt: new Date(0) });
      const unanswered = await f.read();
      expect(unanswered.helpAttempt).toEqual({ choice, state: 'unknown', followUp: 'due' });
      expect(unanswered.pendingConsultationId).toBeUndefined();
    },
  );

  it.each(['choiceAt', 'followUpUpdatedAt'])(
    'uses latest %s even outside the offeredAt window',
    async (field) => {
      const f = await fixture();
      const batch = db.batch();
      for (let n = 0; n < 25; n++) {
        batch.set(f.consultations.doc(`other-${n}`), {
          offeredAt: new Date(`2026-10-03T00:00:${String(n).padStart(2, '0')}Z`),
          choice: 'proxy',
        });
      }
      batch.set(f.consultations.doc('old-attempt'), {
        offeredAt: new Date('2026-09-01'),
        [field]: now,
        choice: 'self',
        followUpAnswer: 'talked',
        followUpAt: later,
      });
      await batch.commit();
      expect((await f.read()).helpAttempt).toEqual({
        choice: 'self',
        state: 'talked',
        followUp: 'scheduled',
      });
    },
  );

  it('carries needs-help into the linked attempt but not into an unrelated new issue', async () => {
    const f = await fixture();
    await f.consultations.doc('old').set({
      choice: 'self',
      offeredAt: new Date('2026-10-01'),
      followUpUpdatedAt: now,
      followUpAnswer: 'need_help',
      followUpState: 'needs_help',
      followUpAnsweredAt: now,
    });
    await f.consultations.doc('next').set({
      offeredAt: now,
      source: 'child_followup',
      previousFollowupId: 'consultation-old',
      followUpReason: 'need_help',
    });
    expect(await f.read()).toMatchObject({
      pendingConsultationId: 'next',
      helpAttempt: { state: 'needs_help', followUp: 'unscheduled' },
    });
    await f.consultations.doc('next').update({ choice: 'proxy', choiceAt: now, followUpAt: later });
    expect((await f.read()).helpAttempt).toEqual({
      choice: 'proxy',
      state: 'needs_help',
      followUp: 'scheduled',
    });
    await f.consultations
      .doc('unrelated')
      .set({ offeredAt: new Date(now.getTime() + 1), source: 'child' });
    expect(await f.read()).toMatchObject({
      pendingConsultationId: 'unrelated',
      helpAttempt: { state: 'unknown', followUp: 'unscheduled' },
    });
  });

  it.each(['supported', 'paused'] as const)(
    'stops old %s prompts without suppressing a new issue',
    async (state) => {
      const f = await fixture();
      await f.consultations.doc('old').set({
        offeredAt: new Date('2026-10-01'),
        choice: 'not_now',
        level: 'l2',
        offerCount: 1,
        followUpAnswer: 'talked',
        followUpState: state,
        followUpUpdatedAt: now,
        followUpAt: new Date(0),
        followUpAnsweredAt: now,
      });
      const stopped = await f.read();
      expect(stopped.helpAttempt).toEqual({ choice: 'not_now', state, followUp: 'stopped' });
      expect(stopped.pendingConsultationId).toBeUndefined();
      await f.consultations
        .doc('new')
        .set({ offeredAt: new Date(now.getTime() + 1), source: 'child' });
      expect(await f.read()).toMatchObject({
        pendingConsultationId: 'new',
        helpAttempt: { state: 'unknown', followUp: 'unscheduled' },
      });
    },
  );

  it.each([
    ['not_now', 'later'],
    ['need_help', 'needs_help'],
    ['supported', 'supported'],
  ])('understands the child answer %s without storing its words', async (answer, state) => {
    const f = await fixture();
    await f.consultations.doc('attempt').set({
      offeredAt: now,
      choice: 'self',
      followUpAnswer: answer,
      ...(answer === 'not_now' ? { followUpAt: later } : { followUpAnsweredAt: now }),
    });
    const result = await f.read();
    expect(result.helpAttempt).toEqual({
      choice: 'self',
      state,
      followUp: answer === 'not_now' ? 'scheduled' : 'stopped',
    });
    expect(result.pendingConsultationId).toBeUndefined();
  });

  it('does not treat arbitrary stored text as a choice, state or model instruction', async () => {
    const f = await fixture();
    const text = 'PRIVATE_UNTRUSTED_TEXT';
    await f.consultations.doc('attempt').set({
      offeredAt: now,
      choice: text,
      followUpState: text,
      followUpAnswer: text,
      followUpReason: text,
    });
    const result = await f.read();
    expect(result.helpAttempt).toEqual({ state: 'unknown', followUp: 'unscheduled' });
    expect(JSON.stringify(result)).not.toContain(text);
  });

  it('refreshes between sessions without exposing parent actions, transcripts or unapproved summaries', async () => {
    const f = await fixture();
    const secret = 'PRIVATE_RAW_TRANSCRIPT';
    const parent = 'PRIVATE_PARENT_FEEDBACK';
    await db
      .doc(f.base)
      .update({ agentSummary: { approved: false, text: secret, expiresAt: later } });
    await f.consultations.doc('attempt').set({
      offeredAt: new Date('2026-10-01'),
      choice: 'proxy',
      followUpAnswer: 'talked',
      followUpState: 'talked',
      followUpUpdatedAt: new Date('2026-10-02'),
      followUpAt: new Date('2099-01-01'),
      summaryText: secret,
      summaryEnc: Buffer.from(secret),
      parentFeedback: { action: parent },
      guardianFeedback: { action: 'talked' },
      notificationId: 'private-notification-id',
      previousFollowupId: 'private-previous-id',
    });
    await db.doc(`families/${f.child.familyId}/notifications/private-notification-id`).set({
      childId: f.child.childId,
      feedback: { action: parent },
    });
    const first = await ask(f.child.childId, 'まだ、どうしたらいいか考えてる');
    expect(first).toContain('\\"state\\":\\"talked\\"');
    await f.consultations.doc('attempt').update({
      followUpState: 'supported',
      followUpAnswer: 'supported',
      followUpUpdatedAt: now,
      followUpAnsweredAt: now,
    });
    const second = await ask(f.child.childId, '今日は絵をかきたい');
    expect(second).toContain('\\"state\\":\\"supported\\"');
    expect(second).toContain('\\"followUp\\":\\"stopped\\"');
    for (const output of [JSON.stringify(await f.read()), first, second, logs.join('\n')]) {
      for (const value of [
        secret,
        parent,
        'private-notification-id',
        'private-previous-id',
        'parentFeedback',
        'guardianFeedback',
      ]) {
        expect(output).not.toContain(value);
      }
    }
  });
});
afterAll(() => db.terminate());

async function ask(childId: string, text: string) {
  const session = await rt.sessions.createSession({ appName: PET_APP_NAME, userId: childId });
  const { messageId } = await rt.sessions.writeChildMessage(childId, session.id, {
    text,
    inputMode: 'typed',
    crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
  });
  const first = model.requests.length;
  const res = await createApp(async () => rt).request('/internal/turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ childId, sessionId: session.id, messageId }),
  });
  expect(res.status).toBe(200);
  await res.text();
  expect(model.requests.length).toBeGreaterThan(first);
  return JSON.stringify(model.requests[first]!.config?.systemInstruction);
}

describe('consented memory prefetch into the real agent instruction', () => {
  it('includes only relevant consented current-pet memories, and forgets on the next turn', async () => {
    const childId = 'c_memory_context';
    const child = (await rt.directory.lookup(childId))!;
    const path = `families/${child.familyId}/children/${childId}/memories`;
    const fixtures = {
      accepted: { text: 'サッカーの練習は火曜日', consentedAt: new Date() },
      pending: { text: 'サッカーの候補は未確認', status: 'pending' },
      rejected: { text: 'サッカーの候補は拒否', status: 'rejected', consentedAt: new Date() },
      expired: { text: 'サッカーの期限切れ', consentedAt: new Date(), expiresAt: new Date(0) },
      deleted: { text: 'サッカーの削除済み', consentedAt: new Date(), deletedAt: new Date() },
      otherCharacter: { text: 'サッカーの別キャラ', consentedAt: new Date(), characterId: 'pokke' },
      otherPet: { text: 'サッカーの別の相棒', consentedAt: new Date(), petId: 'p_other' },
      unrelated: { text: '水泳は土曜日', consentedAt: new Date() },
    };
    for (const [id, { text, ...extra }] of Object.entries(fixtures)) {
      await db.doc(`${path}/${id}`).set({
        category: 'event',
        characterId: child.characterId,
        petId: child.petId,
        contentEnc: rt.sessions.encryptForChild(child, text, `${path}#contentEnc`),
        createdAt: new Date(),
        ...extra,
      });
    }
    const instruction = await ask(childId, 'サッカー');
    expect(instruction).toContain(fixtures.accepted.text);
    for (const [id, value] of Object.entries(fixtures)) {
      if (id !== 'accepted') expect(instruction).not.toContain(value.text);
    }
    expect(await ask(childId, '音楽')).not.toContain(fixtures.accepted.text);
    await db.doc(`${path}/accepted`).delete();
    expect(await ask(childId, 'サッカー')).not.toContain(fixtures.accepted.text);
    expect(logs.join('\n')).not.toContain(fixtures.accepted.text);
  });
});
