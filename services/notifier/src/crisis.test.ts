import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { ScriptedLlm } from '@ijime/agent-core';
import { crisis as crisisConfig } from '@ijime/config';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { encodePushEnvelope, Logger, MemoryTaskQueue, type TaskSpec } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { LogOnlySender, MemorySender } from './channels.js';
import { crisisNotificationId } from './crisis.js';
import type { NotifierDeps } from './deps.js';
import * as notificationStore from './store.js';
import type { NotificationDoc } from './store.js';
import { MemoryDailyFeatures } from './weekly-source.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SENTINEL = 'SENTINEL_子どもの言葉';

let db: Firestore;
let kb: Kb;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-notify-crisis-${randomUUID().slice(0, 8)}` });
  kb = await Kb.load(new FsKbSource(KB_DIR));
});
afterAll(() => db.terminate());

async function seedFamily(familyId: string, childId: string): Promise<void> {
  await db.doc(`families/${familyId}`).set({ familyId, status: 'active' });
  await db.doc(`families/${familyId}/children/${childId}`).set({
    childId,
    familyId,
    nickname: 'はな',
    gradeBand: 'high',
    currentRiskLevel: 'l0',
  });
  await db.doc(`families/${familyId}/guardians/g1`).set({
    guardianId: 'g1',
    role: 'primary',
    email: 'a@example.com',
    phoneE164: '+819012345678',
    notifyChannels: ['webpush', 'email'],
  });
  await db.doc(`families/${familyId}/guardians/g2`).set({
    guardianId: 'g2',
    role: 'secondary',
    email: 'b@example.com',
    notifyChannels: ['email'],
  });
  await db
    .doc(`families/${familyId}/devices/d1`)
    .set({ ownerType: 'guardian', ownerId: 'g1', fcmToken: 'tok-1', lastSeenAt: new Date() });
}

async function seedCrisis(
  familyId: string,
  childId: string,
  crisisId: string,
  familyHarmSuspected: boolean,
): Promise<void> {
  await db.doc(`families/${familyId}/children/${childId}/crisisEvents/${crisisId}`).set({
    triggerType: 'text',
    sourceRef: `families/${familyId}/children/${childId}/sessions/s/messages/m`,
    detection: { keywordMatched: true, method: 'keyword', category: 'suicidal', confidence: 1 },
    familyHarmSuspected,
    timeline: [{ step: 'safe_mode_shown', at: new Date() }],
    status: 'open',
    createdAt: new Date(),
  });
  // notifier は会話を読まないはず。この1件は、センチネル文字列が外に漏れないことを確認するためだけに置く
  await db
    .doc(`families/${familyId}/children/${childId}/sessions/s/messages/m`)
    .set({ role: 'child', text: SENTINEL });
}

function setup() {
  const lines: string[] = [];
  const logger = new Logger('notifier', (l) => lines.push(l));
  const tasks = new MemoryTaskQueue();
  const webpush = new MemorySender();
  const email = new LogOnlySender('email', logger);
  const sms = new LogOnlySender('sms', logger);
  let clock = Date.parse('2026-10-01T09:00:00Z');
  const deps: NotifierDeps = {
    db,
    kb,
    model: new ScriptedLlm(() => {
      throw new Error('crisis path must not call the model');
    }),
    tasks,
    senders: { webpush, email, sms },
    logger,
    selfUrl: 'http://notifier.test',
    features: new MemoryDailyFeatures(),
    now: () => new Date(clock),
  };
  const app = createApp(async () => deps, logger);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  const run = async (list: TaskSpec[]) => {
    const codes: number[] = [];
    for (const t of list) codes.push((await post(new URL(t.url).pathname, t.body)).status);
    return codes;
  };
  return {
    lines,
    tasks,
    webpush,
    email,
    sms,
    post,
    run,
    advance: (ms: number) => (clock += ms),
  };
}

const crisisEvent = (childId: string, crisisId: string, familyHarmSuspected = false) =>
  encodePushEnvelope({ childId, crisisId, familyHarmSuspected });

async function readNotification(
  familyId: string,
  id: string,
): Promise<NotificationDoc | undefined> {
  return (await db.doc(`families/${familyId}/notifications/${id}`).get()).data() as
    NotificationDoc | undefined;
}

describe('S1 text crisis → notify all guardians, resend until acknowledged', () => {
  it('runs the whole escalation loop', async () => {
    const [f, c, k] = ['f_s1', 'c_s1', 'k_s1'];
    await seedFamily(f, c);
    await seedCrisis(f, c, k, false);
    const t = setup();

    expect((await t.post('/internal/events/crisis-detected', crisisEvent(c, k))).status).toBe(204);
    const nid = crisisNotificationId(c, k);
    const notif = await readNotification(f, nid);
    expect(notif).toMatchObject({
      childId: c,
      kind: 'crisis',
      level: 'l4',
      recipientIds: ['g1', 'g2'],
      channels: ['webpush', 'email', 'sms'],
      status: 'queued',
    });
    expect(notif!.payload.title).toBe('今すぐはなさんのそばにいてください');

    const crisisDoc = (
      await db.doc(`families/${f}/children/${c}/crisisEvents/${k}`).get()
    ).data() as { notificationId: string; timeline: { step: string }[] };
    expect(crisisDoc.notificationId).toBe(nid);
    expect(crisisDoc.timeline.map((e) => e.step)).toContain('guardian_notified');

    const sends = t.tasks.take('notify-send');
    expect(sends).toHaveLength(4);
    const esc = t.tasks.take('crisis-escalation');
    expect(esc).toHaveLength(1);
    expect(esc[0]!.delaySeconds).toBe(crisisConfig.guardianAckTimeoutMinutes * 60);

    // 重複配信：2件目の通知は作らず、タスクも重ねて登録しない
    expect((await t.post('/internal/events/crisis-detected', crisisEvent(c, k))).status).toBe(204);
    expect(t.tasks.tasks).toHaveLength(0);
    const all = await db.collection(`families/${f}/notifications`).get();
    expect(all.size).toBe(1);

    expect(await t.run(sends)).toEqual([204, 204, 204, 204]);
    expect(t.webpush.sent).toHaveLength(1);
    expect(t.webpush.sent[0]!.msg).toMatchObject({
      pushTitle: '緊急：お子さんの安全に関するお知らせ',
      pushBody: '新しいお知らせがあります。アプリで確認してください。',
    });
    expect(t.email.sent.map((s) => s.guardianId).sort()).toEqual(['g1', 'g2']);
    expect(t.sms.sent.map((s) => s.guardianId)).toEqual(['g1']);
    const afterSend = await readNotification(f, nid);
    expect(afterSend!.status).toBe('sent');
    expect(afterSend!.attempts).toHaveLength(4);

    // 規定時間内に確認がない → 再送を1回行い、次回分を登録する
    t.advance(crisisConfig.guardianAckTimeoutMinutes * 60_000);
    expect(await t.run(esc)).toEqual([204]);
    const resends = t.tasks.take('notify-send');
    expect(resends).toHaveLength(4);
    expect(resends.every((r) => r.body['round'] === 1)).toBe(true);
    const esc2 = t.tasks.take('crisis-escalation');
    expect(esc2).toHaveLength(1);
    expect(esc2[0]!.delaySeconds).toBe(crisisConfig.resendIntervalMinutes * 60);
    const timeline = (
      (await db.doc(`families/${f}/children/${c}/crisisEvents/${k}`).get()).data() as {
        timeline: { step: string }[];
      }
    ).timeline.map((e) => e.step);
    expect(timeline).toContain('resent');

    // 保護者の確認後：未送信の再送は取り消し、次回分も登録しない
    await db
      .doc(`families/${f}/notifications/${nid}`)
      .update({ acknowledgedAt: new Date(), acknowledgedBy: 'g2', status: 'acknowledged' });
    expect(await t.run(resends)).toEqual([204, 204, 204, 204]);
    expect(t.webpush.sent).toHaveLength(1);
    expect(await t.run(esc2)).toEqual([204]);
    expect(t.tasks.tasks).toHaveLength(0);
    const final = await readNotification(f, nid);
    expect(final!.attempts).toHaveLength(4);
    expect(final!.status).toBe('acknowledged');

    const logs = t.lines.join('\n');
    expect(logs).not.toContain(SENTINEL);
    expect(logs).not.toContain('はな');
  });

  it('stops and alerts after the resend limit', async () => {
    const [f, c, k] = ['f_lim', 'c_lim', 'k_lim'];
    await seedFamily(f, c);
    await seedCrisis(f, c, k, false);
    const t = setup();
    await t.post('/internal/events/crisis-detected', crisisEvent(c, k));
    t.tasks.take('notify-send');
    let esc = t.tasks.take('crisis-escalation');
    for (let round = 1; round <= crisisConfig.maxResendRounds; round++) {
      await t.run(esc);
      t.tasks.take('notify-send');
      esc = t.tasks.take('crisis-escalation');
      expect(esc).toHaveLength(1);
    }
    await t.run(esc);
    expect(t.tasks.tasks).toHaveLength(0);
    expect(t.lines.some((l) => l.includes('crisis.escalation_exhausted'))).toBe(true);
  });

  it('asks Cloud Tasks to retry when a channel fails transiently', async () => {
    const [f, c, k] = ['f_retry', 'c_retry', 'k_retry'];
    await seedFamily(f, c);
    await seedCrisis(f, c, k, false);
    const t = setup();
    await t.post('/internal/events/crisis-detected', crisisEvent(c, k));
    const push = t.tasks.take('notify-send').find((s) => s.body['channel'] === 'webpush')!;
    t.webpush.failNext = 1;
    expect(await t.run([push])).toEqual([503]);
    expect(await t.run([push])).toEqual([204]);
    expect(t.webpush.sent).toHaveLength(1);
  });

  it('retries the event when the crisis document is not visible yet', async () => {
    const [f, c] = ['f_race', 'c_race'];
    await seedFamily(f, c);
    const t = setup();
    expect(
      (await t.post('/internal/events/crisis-detected', crisisEvent(c, 'k_none'))).status,
    ).toBe(503);
  });
});

describe('escalation refreshes reachable channels', () => {
  async function pushOnlyCrisis() {
    const suffix = randomUUID();
    const [f, c, k] = [`f_${suffix}`, `c_${suffix}`, 'crisis'];
    await seedFamily(f, c);
    await db.doc(`families/${f}/guardians/g1`).set({ notifyChannels: ['webpush'] });
    await db.doc(`families/${f}/guardians/g2`).delete();
    await seedCrisis(f, c, k, false);
    const t = setup();
    expect((await t.post('/internal/events/crisis-detected', crisisEvent(c, k))).status).toBe(204);
    const notification = db.doc(`families/${f}/notifications/${crisisNotificationId(c, k)}`);
    expect((await notification.get()).get('channels')).toEqual(['webpush']);
    expect(await t.run(t.tasks.take('notify-send'))).toEqual([204]);
    const escalation = t.tasks.take('crisis-escalation');
    expect(escalation).toHaveLength(1);
    const addPhone = (guardianId = 'g1') =>
      db
        .doc(`families/${f}/guardians/${guardianId}`)
        .set({ phoneE164: '+819000000000', notifyChannels: [] }, { merge: true });
    return { ...t, f, c, k, notification, escalation, addPhone };
  }

  it.each(['g1', 'g2'])(
    'sends a newly registered SMS channel to %s exactly once per round',
    async (guardianId) => {
      const t = await pushOnlyCrisis();
      await t.addPhone(guardianId);
      expect(await Promise.all([t.run(t.escalation), t.run(t.escalation)])).toEqual([[204], [204]]);
      const resends = t.tasks.take('notify-send');
      expect(resends).toHaveLength(2);
      expect(resends.map((task) => task.body)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ guardianId: 'g1', channel: 'webpush', round: 1 }),
          expect.objectContaining({ guardianId, channel: 'sms', round: 1 }),
        ]),
      );
      expect(new Set(resends.map((task) => task.taskId)).size).toBe(2);
      expect((await t.notification.get()).get('channels')).toEqual(['webpush', 'sms']);
      expect(t.tasks.take('crisis-escalation')).toHaveLength(1);
      expect(await t.run(resends)).toEqual([204, 204]);
      expect(t.sms.sent.map((sent) => sent.guardianId)).toEqual([guardianId]);
      expect(t.webpush.sent).toHaveLength(2);
      expect(t.lines.join('\n')).not.toContain(SENTINEL);
    },
  );

  it('does not refresh or enqueue if acknowledgement wins the guardian lookup race', async () => {
    const t = await pushOnlyCrisis();
    await t.addPhone('g2');
    const original = notificationStore.listGuardians;
    const spy = vi
      .spyOn(notificationStore, 'listGuardians')
      .mockImplementationOnce(async (...args) => {
        const guardians = await original(...args);
        await t.notification.update({ acknowledgedAt: new Date(), status: 'acknowledged' });
        return guardians;
      });
    try {
      expect(await t.run(t.escalation)).toEqual([204]);
    } finally {
      spy.mockRestore();
    }
    expect(t.tasks.tasks).toEqual([]);
    expect((await t.notification.get()).data()).toMatchObject({
      status: 'acknowledged',
      recipientIds: ['g1'],
      channels: ['webpush'],
    });
    expect(t.sms.sent).toEqual([]);
  });

  it('cancels newly queued SMS when acknowledgement arrives before delivery', async () => {
    const t = await pushOnlyCrisis();
    await t.addPhone();
    expect(await t.run(t.escalation)).toEqual([204]);
    const resends = t.tasks.take('notify-send');
    expect(resends).toHaveLength(2);
    await t.notification.update({ acknowledgedAt: new Date(), status: 'acknowledged' });
    expect(await t.run(resends)).toEqual([204, 204]);
    expect(await t.run(t.tasks.take('crisis-escalation'))).toEqual([204]);
    expect(t.tasks.tasks).toEqual([]);
    expect(t.sms.sent).toEqual([]);
    expect(t.webpush.sent).toHaveLength(1);
  });

  it('suppresses refresh during family harm and cannot restore a redacted notification', async () => {
    const t = await pushOnlyCrisis();
    await t.addPhone('g2');
    const crisis = db.doc(`families/${t.f}/children/${t.c}/crisisEvents/${t.k}`);
    const original = notificationStore.listGuardians;
    const spy = vi
      .spyOn(notificationStore, 'listGuardians')
      .mockImplementationOnce(async (...args) => {
        const guardians = await original(...args);
        await crisis.update({ familyHarmSuspected: true });
        return guardians;
      });
    try {
      expect(await t.run(t.escalation)).toEqual([204]);
    } finally {
      spy.mockRestore();
    }
    expect(t.tasks.tasks).toEqual([]);
    expect((await t.notification.get()).data()).toMatchObject({
      status: 'failed',
      recipientIds: [],
      channels: [],
      payload: { title: '' },
    });
    await crisis.update({ status: 'closed' });
    expect(await t.run(t.escalation)).toEqual([204]);
    expect((await t.notification.get()).data()).toMatchObject({
      status: 'failed',
      recipientIds: [],
      channels: [],
      payload: { title: '' },
    });
    expect(t.tasks.tasks).toEqual([]);
    expect(t.sms.sent).toEqual([]);
    expect(t.webpush.sent).toHaveLength(1);
  });

  it('suppresses newly queued SMS when family harm is discovered before delivery', async () => {
    const t = await pushOnlyCrisis();
    await t.addPhone();
    expect(await t.run(t.escalation)).toEqual([204]);
    const resends = t.tasks.take('notify-send');
    expect(resends).toHaveLength(2);
    await db
      .doc(`families/${t.f}/children/${t.c}/crisisEvents/${t.k}`)
      .update({ familyHarmSuspected: true });
    expect(await t.run(resends)).toEqual([204, 204]);
    expect(await t.run(t.tasks.take('crisis-escalation'))).toEqual([204]);
    expect((await t.notification.get()).data()).toMatchObject({
      status: 'failed',
      recipientIds: [],
      channels: [],
    });
    expect(t.tasks.tasks).toEqual([]);
    expect(t.sms.sent).toEqual([]);
    expect(t.webpush.sent).toHaveLength(1);
  });
});

describe('S2 family harm suspected → no guardian is notified', () => {
  it('suppresses based on the event flag', async () => {
    const [f, c, k] = ['f_s2', 'c_s2', 'k_s2'];
    await seedFamily(f, c);
    await seedCrisis(f, c, k, true);
    const t = setup();
    expect((await t.post('/internal/events/crisis-detected', crisisEvent(c, k, true))).status).toBe(
      204,
    );
    expect(t.tasks.tasks).toHaveLength(0);
    expect((await db.collection(`families/${f}/notifications`).get()).size).toBe(0);
  });

  it('also suppresses when only the stored crisis says family harm', async () => {
    const [f, c, k] = ['f_s2b', 'c_s2b', 'k_s2b'];
    await seedFamily(f, c);
    await seedCrisis(f, c, k, true);
    const t = setup();
    await t.post('/internal/events/crisis-detected', crisisEvent(c, k, false));
    expect(t.tasks.tasks).toHaveLength(0);
    expect((await db.collection(`families/${f}/notifications`).get()).size).toBe(0);
  });
});
