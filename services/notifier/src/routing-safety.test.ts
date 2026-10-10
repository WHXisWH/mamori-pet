import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { ScriptedLlm } from '@ijime/agent-core';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { encodePushEnvelope, Logger, MemoryTaskQueue } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { MemorySender } from './channels.js';
import { careHintId, contentFreeId, CONSULTATION_TIMEOUT_PATH } from './consultation.js';
import { SEND_TASK_PATH } from './delivery.js';
import type { NotifierDeps } from './deps.js';
import { MemoryDailyFeatures } from './weekly-source.js';

const SUMMARY = 'PRIVATE_SUMMARY_SENTINEL';
const GOOD = {
  title: 'Testさんからの相談',
  changes: [],
  meaning:
    'お子さんが共有に同意した内容をお届けします。出来事を第三者が確認したものではありません。まずは落ち着いてお話を聞いてみてください。',
  suggestions: {
    try: ['Spend time together', 'Listen without interrupting'],
    avoid: ['Interrogating'],
  },
};
let db: Firestore;
let kb: Kb;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  // Never reset a shared emulator or reuse another suite's project/identities.
  db = new Firestore({ projectId: `demo-notify-${randomUUID().slice(0, 8)}` });
  kb = await Kb.load(
    new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
  );
});
afterAll(async () => {
  vi.restoreAllMocks();
  await db.terminate();
});

async function world() {
  const id = randomUUID();
  const familyId = `f_${id}`;
  const childId = `c_${id}`;
  const consultationId = 'consult';
  const base = `families/${familyId}/children/${childId}`;
  const owner = db.doc(base);
  const consultation = db.doc(`${base}/consultations/${consultationId}`);
  const crisis = db.doc(`${base}/crisisEvents/crisis`);
  const notificationId = careHintId(childId, consultationId);
  const notification = db.doc(`families/${familyId}/notifications/${notificationId}`);
  await owner.set({ childId, familyId, nickname: 'Test', gradeBand: 'high', status: 'active' });
  await consultation.set({ level: 'l3', assessmentId: 'a1', choice: 'proxy' });
  await db.doc(`families/${familyId}/guardians/g1`).set({
    guardianId: 'g1',
    notifyChannels: ['email'],
    email: 'synthetic@example.test',
  });
  await notification.set({
    childId,
    recipientIds: [],
    channels: [],
    kind: 'care_hint',
    level: 'l3',
    templateId: '',
    payload: { childSummary: SUMMARY },
    status: 'queued',
    attempts: [],
    createdAt: new Date(),
  });
  const lines: string[] = [];
  const logger = new Logger('notifier-safety', (line) => lines.push(line));
  const llm = new ScriptedLlm(() => ({ text: JSON.stringify(GOOD) }));
  const sender = new MemorySender();
  const tasks = new MemoryTaskQueue();
  const deps: NotifierDeps = {
    db,
    kb,
    model: llm,
    tasks,
    senders: { webpush: sender, email: sender, sms: sender },
    logger,
    selfUrl: 'http://notifier.test',
    features: new MemoryDailyFeatures(),
    now: () => new Date(),
  };
  const app = createApp(async () => deps, logger);
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const proxy = () =>
    post(
      '/internal/events/consultation-resolved',
      encodePushEnvelope({ childId, consultationId, choice: 'proxy' }),
    );
  const timeout = () => post(CONSULTATION_TIMEOUT_PATH, { childId, familyId, consultationId });
  const send = () =>
    post(SEND_TASK_PATH, {
      familyId,
      notificationId,
      guardianId: 'g1',
      channel: 'email',
      round: 0,
    });
  const assertRedacted = async () => {
    const data = (await notification.get()).data();
    expect(data).toMatchObject({
      status: 'failed',
      recipientIds: [],
      channels: [],
      templateId: '',
      payload: { title: '', meaning: '', childSummary: null, changes: [] },
    });
    expect(JSON.stringify(data)).not.toContain(SUMMARY);
    expect(lines.join('\n')).not.toContain(SUMMARY);
    expect(sender.sent).toEqual([]);
  };
  return {
    base,
    familyId,
    childId,
    consultationId,
    owner,
    consultation,
    crisis,
    notification,
    llm,
    tasks,
    sender,
    proxy,
    send,
    timeout,
    assertRedacted,
  };
}

describe('authoritative guardian routing', () => {
  it.each([
    ['open', true],
    ['guardian_acknowledged', true],
    ['open', undefined],
    ['guardian_acknowledged', undefined],
  ] as const)(
    'redacts queued proxy before processing: %s, family harm %s',
    async (status, harm) => {
      const w = await world();
      await w.crisis.set({ status, ...(harm === undefined ? {} : { familyHarmSuspected: harm }) });
      expect((await w.proxy()).status).toBe(204);
      await w.assertRedacted();
      expect(w.llm.requests).toHaveLength(0);
      expect(w.tasks.tasks).toEqual([]);
      // Old events remain suppressed even after a later legitimate crisis closure.
      await w.crisis.update({ status: 'closed' });
      expect((await w.proxy()).status).toBe(204);
      expect((await w.send()).status).toBe(204);
      await w.assertRedacted();
    },
  );

  it('keeps suppressing the proxy for 24 hours after the child acknowledges family harm', async () => {
    const w = await world();
    await w.crisis.set({
      status: 'child_acknowledged',
      familyHarmSuspected: true,
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      timeline: [{ step: 'child_acknowledged', at: new Date(Date.now() - 1 * 3_600_000) }],
    });
    expect((await w.proxy()).status).toBe(204);
    await w.assertRedacted();
    expect(w.llm.requests).toHaveLength(0);
  });

  it('routes the proxy again once a family-harm acknowledgement is 24 hours old', async () => {
    const w = await world();
    await w.crisis.set({
      status: 'guardian_acknowledged',
      familyHarmSuspected: true,
      timeline: [{ step: 'guardian_acknowledged', at: new Date(Date.now() - 25 * 3_600_000) }],
    });
    expect((await w.proxy()).status).toBe(204);
    expect(w.llm.requests).toHaveLength(1);
    expect(w.tasks.tasks).toHaveLength(1);
  });

  it.each([true, false])(
    'redacts queued-before-delete events (consultation retained: %s)',
    async (keep) => {
      const w = await world();
      await w.owner.update({ status: 'deleting' });
      if (!keep) await w.consultation.delete();
      expect((await w.proxy()).status).toBe(204);
      await w.assertRedacted();
      expect(w.llm.requests).toHaveLength(0);
      expect(w.tasks.tasks).toEqual([]);
      expect((await w.consultation.get()).exists).toBe(keep);
    },
  );

  it.each(['family_harm', 'unknown', 'deleting', 'missing_child'] as const)(
    'revalidates already queued delivery after %s',
    async (condition) => {
      const w = await world();
      expect((await w.proxy()).status).toBe(204);
      expect(w.tasks.tasks).toHaveLength(1);
      await w.notification.update({
        'payload.title': SUMMARY,
        'payload.changes': [SUMMARY],
        'payload.meaning': SUMMARY,
        'payload.suggestions': { try: [SUMMARY], avoid: [SUMMARY] },
      });
      if (condition === 'deleting') await w.owner.update({ status: 'deleting' });
      else if (condition === 'missing_child') await w.owner.delete();
      else
        await w.crisis.set({
          status: 'open',
          ...(condition === 'family_harm' ? { familyHarmSuspected: true } : {}),
        });
      expect((await w.send()).status).toBe(204);
      expect((await w.send()).status).toBe(204);
      await w.assertRedacted();
    },
  );

  it.each(['family_harm', 'deleting'] as const)(
    'does not restore payload if %s begins during generation',
    async (condition) => {
      const w = await world();
      const original = w.llm.generateContentAsync.bind(w.llm);
      vi.spyOn(w.llm, 'generateContentAsync').mockImplementation(async function* (request, stream) {
        if (condition === 'deleting') await w.owner.update({ status: 'deleting' });
        else await w.crisis.set({ status: 'open', familyHarmSuspected: true });
        yield* original(request, stream);
      });
      expect((await w.proxy()).status).toBe(204);
      expect(w.llm.requests).toHaveLength(1);
      await w.assertRedacted();
      expect(w.tasks.tasks).toEqual([]);
    },
  );

  it('rejects a stale proxy event after the stored choice changes', async () => {
    const w = await world();
    await w.consultation.update({ choice: 'self' });
    expect((await w.proxy()).status).toBe(204);
    await w.assertRedacted();
    expect(w.llm.requests).toHaveLength(0);
  });

  it('does not retract an authorized proxy when an old timeout arrives', async () => {
    const w = await world();
    expect((await w.proxy()).status).toBe(204);
    expect((await w.timeout()).status).toBe(204);
    expect((await w.notification.get()).get('payload.childSummary')).toBe(SUMMARY);
    expect((await w.notification.get()).get('status')).toBe('queued');
    expect((await w.send()).status).toBe(204);
    expect(w.sender.sent).toHaveLength(1);
  });

  it('rechecks safety after loading delivery dependencies', async () => {
    const w = await world();
    expect((await w.proxy()).status).toBe(204);
    const original = kb.text.bind(kb);
    const spy = vi.spyOn(kb, 'text').mockImplementation(async (path) => {
      await w.crisis.set({ status: 'open', familyHarmSuspected: true });
      return original(path);
    });
    try {
      expect((await w.send()).status).toBe(204);
      await w.assertRedacted();
    } finally {
      spy.mockRestore();
    }
  });

  it('does not let a harmless crisis hide a simultaneous family-harm crisis', async () => {
    const w = await world();
    await w.crisis.set({ status: 'open', familyHarmSuspected: false });
    await db.doc(`${w.base}/crisisEvents/second`).set({
      status: 'guardian_acknowledged',
      familyHarmSuspected: true,
    });
    expect((await w.proxy()).status).toBe(204);
    await w.assertRedacted();
    expect(w.tasks.tasks).toEqual([]);
  });

  it('suppresses a timeout and redacts its related draft during family harm', async () => {
    const w = await world();
    await w.consultation.set({ level: 'l3', assessmentId: 'a1' });
    await w.crisis.set({ status: 'open', familyHarmSuspected: true });
    expect((await w.timeout()).status).toBe(204);
    await w.assertRedacted();
    expect(w.tasks.tasks).toEqual([]);
    expect(
      (
        await db
          .doc(`families/${w.familyId}/notifications/${contentFreeId(w.childId, w.consultationId)}`)
          .get()
      ).exists,
    ).toBe(false);
  });

  it.each([{ familyHarmSuspected: true }, { crisisId: 'old-crisis' }])(
    'honors persisted consultation safety flags: %j',
    async (flags) => {
      const w = await world();
      await w.consultation.update(flags);
      expect((await w.proxy()).status).toBe(204);
      await w.assertRedacted();
      expect(w.llm.requests).toHaveLength(0);
    },
  );

  it.each([
    { status: 'open', familyHarmSuspected: false },
    { status: 'closed', familyHarmSuspected: true },
  ])('preserves safe routing: %j', async (crisis) => {
    const w = await world();
    await w.crisis.set(crisis);
    expect((await w.proxy()).status).toBe(204);
    expect((await w.send()).status).toBe(204);
    expect(w.sender.sent).toHaveLength(1);
    expect((await w.notification.get()).get('payload.childSummary')).toBe(SUMMARY);
  });
});
