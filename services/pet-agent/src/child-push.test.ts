import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Firestore } from '@google-cloud/firestore';
import type { ChildDirectory, ChildRecord } from '@ijime/agent-core';
import type { ProactiveTurnReq } from '@ijime/api-types';
import type { Kb } from '@ijime/kb-loader';
import { GoogleHttpError, type GoogleHttp } from '@ijime/service-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChildPushSender } from './child-push.js';

let db: Firestore;
let at: Date;
const request = vi.fn<GoogleHttp['request']>();
const directory: ChildDirectory = {
  lookup: async (childId) => ({ childId, familyId: 'f1' }) as ChildRecord,
};
const copy = JSON.parse(
  readFileSync(new URL('../../../apps/child-web/public/push-copy.json', import.meta.url), 'utf8'),
);
const kb = { yaml: vi.fn(async (_path, schema) => schema.parse(copy)) } as unknown as Kb;
const env = {
  CHILD_PUSH_ENABLED: 'true',
  GCP_PROJECT_ID: 'demo-child-push',
  CHILD_WEB_ORIGIN: 'https://child.test',
};
const task: ProactiveTurnReq & { turnId: string } = {
  childId: 'c1',
  localDate: '2026-10-06',
  slot: 'after_school',
  turnId: '2026-10-06-after_school',
};
const create = (override = {}) =>
  createChildPushSender({
    db,
    directory,
    kb,
    env,
    http: { request } as GoogleHttp,
    now: () => at,
    ...override,
  });
const child = () => db.doc('families/f1/children/c1');
const device = (id = 'a'.repeat(64)) => db.doc(`families/f1/devices/${id}`);

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-push-send-${randomUUID()}` });
});
afterAll(() => db.terminate());
beforeEach(async () => {
  request.mockReset().mockResolvedValue({ name: 'synthetic-message' });
  at = new Date('2026-10-06T07:00:00Z');
  await db.recursiveDelete(db.doc('families/f1'));
  await db.doc('families/f1').set({ status: 'active' });
  await child().set({
    childId: 'c1',
    status: 'active',
    assentComplete: true,
    proactiveEnabled: true,
    proactiveSlots: ['after_school'],
  });
  await device().set({ ownerType: 'child', ownerId: 'c1', fcmToken: 'synthetic-token' });
});

describe('fixed child FCM sender', () => {
  it('stays absent until explicitly enabled, and rejects an unsafe origin', async () => {
    expect(await create({ env: {} })).toBeUndefined();
    for (const origin of [
      'http://child.test',
      'https://child.test/path',
      'https://user:pass@child.test',
      'https://child.test?secret=1',
    ])
      await expect(create({ env: { ...env, CHILD_WEB_ORIGIN: origin } })).rejects.toThrow(
        'child_push_https_origin_required',
      );
    expect(request).not.toHaveBeenCalled();
  });
  it('sends only fixed KB copy and routing metadata to child-owned devices', async () => {
    await device('guardian').set({
      ownerType: 'guardian',
      ownerId: 'c1',
      fcmToken: 'guardian-token',
    });
    await device('sibling').set({ ownerType: 'child', ownerId: 'c2', fcmToken: 'sibling-token' });
    const sender = (await create())!;
    expect(await sender.send(task)).toEqual({ status: 'sent', sent: 1, removed: 0, failed: 0 });
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://fcm.googleapis.com/v1/projects/demo-child-push/messages:send',
      retry: false,
      timeoutMs: 5000,
      body: {
        message: {
          token: 'synthetic-token',
          data: {
            kind: 'child_greeting',
            deviceId: 'a'.repeat(64),
            title: copy.title,
            body: copy.body,
            url: 'https://child.test/',
          },
          webpush: { headers: { TTL: '0', Urgency: 'normal' } },
        },
      },
    });
    expect(JSON.stringify(request.mock.calls)).not.toMatch(/childId|familyId|turnId|notification"/);
  });
  it.each([
    { status: 'paused' },
    { status: 'deleting' },
    { assentComplete: false },
    { proactiveEnabled: false },
    { proactiveSlots: ['morning'] },
    { proactiveSlots: [] },
  ])('does not send when current child preferences forbid it: %j', async (fields) => {
    await child().update(fields);
    expect((await (await create())!.send(task)).status).toBe('skipped');
    expect(request).not.toHaveBeenCalled();
  });
  it.each(['2026-10-06T14:00:00Z', '2026-10-05T19:59:00Z', '2026-10-07T07:00:00Z'])(
    'does not send in quiet hours or on a stale date: %s',
    async (value) => {
      at = new Date(value);
      expect((await (await create())!.send(task)).status).toBe('skipped');
      expect(request).not.toHaveBeenCalled();
    },
  );
  it('does not send during an open crisis or inactive family', async () => {
    await child().collection('crisisEvents').doc('crisis').set({ status: 'open' });
    expect((await (await create())!.send(task)).status).toBe('skipped');
    await child().collection('crisisEvents').doc('crisis').delete();
    await db.doc('families/f1').update({ status: 'deleting' });
    expect((await (await create())!.send(task)).status).toBe('skipped');
    expect(request).not.toHaveBeenCalled();
  });
  it('removes only a confirmed stale FCM token', async () => {
    request.mockRejectedValue(
      new GoogleHttpError(
        404,
        JSON.stringify({
          error: {
            details: [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode: 'UNREGISTERED',
              },
            ],
          },
        }),
      ),
    );
    expect(await (await create())!.send(task)).toEqual({
      status: 'skipped',
      sent: 0,
      removed: 1,
      failed: 0,
    });
    expect((await device().get()).exists).toBe(false);
  });
  it.each([400, 403, 404, 429, 500])(
    'preserves tokens on unrelated HTTP %s errors and does not retry',
    async (status) => {
      request.mockRejectedValue(new GoogleHttpError(status, 'not a confirmed token error'));
      expect(await (await create())!.send(task)).toEqual({
        status: 'failed',
        sent: 0,
        removed: 0,
        failed: 1,
      });
      expect((await device().get()).exists).toBe(true);
      expect(request).toHaveBeenCalledOnce();
    },
  );
  it('stops sending when the preference changes between devices', async () => {
    await device('b'.repeat(64)).set({
      ownerType: 'child',
      ownerId: 'c1',
      fcmToken: 'second-token',
    });
    request.mockImplementationOnce(async () => {
      await child().update({ proactiveEnabled: false });
      return {} as never;
    });
    expect((await (await create())!.send(task)).sent).toBe(1);
    expect(request).toHaveBeenCalledOnce();
  });
  it('does not delete a token that changed while FCM was responding', async () => {
    request.mockImplementationOnce(async () => {
      await device().update({ fcmToken: 'rotated-token' });
      throw new GoogleHttpError(
        404,
        JSON.stringify({
          error: {
            details: [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode: 'UNREGISTERED',
              },
            ],
          },
        }),
      );
    });
    expect((await (await create())!.send(task)).removed).toBe(0);
    expect((await device().get()).get('fcmToken')).toBe('rotated-token');
  });
});
