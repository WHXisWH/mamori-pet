import { createHash, randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type { ChildDirectory, ChildRecord } from '@ijime/agent-core';
import { createServiceApp, Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerChildDevices } from './routes/child-devices.js';

let db: Firestore;
const logs: string[] = [];
const app = createServiceApp({
  name: 'device-test',
  logger: new Logger('test', (line) => logs.push(line)),
});
const directory: ChildDirectory = {
  lookup: async (childId) =>
    ({ childId, familyId: childId === 'other' ? 'f_other' : 'f_test' }) as ChildRecord,
};
const headers = { 'Content-Type': 'application/json', 'X-Dev-Child-Id': 'c_one' };
const id = (token: string) => createHash('sha256').update(token).digest('hex');
const register = (token: string, child = 'c_one', extra = {}) =>
  app.request('/v1/child/devices', {
    method: 'POST',
    headers: { ...headers, 'X-Dev-Child-Id': child },
    body: JSON.stringify({ fcmToken: token, platform: 'desktop', ...extra }),
  });

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-child-push-${randomUUID()}` });
  for (const family of ['f_test', 'f_other'])
    await db.doc(`families/${family}`).set({ status: 'active' });
  for (const childId of ['c_one', 'c_two', 'other'])
    await db
      .doc(`families/${childId === 'other' ? 'f_other' : 'f_test'}/children/${childId}`)
      .set({ childId, status: 'active' });
  registerChildDevices(app, async () => ({ db, directory, auth: { allowDevHeader: true } }));
});
afterAll(() => db.terminate());

describe('child device ownership', () => {
  it('requires child auth and does not accept owner identity from the request', async () => {
    expect((await app.request('/v1/child/devices', { method: 'POST' })).status).toBe(401);
    expect(
      (
        await app.request('/v1/child/devices', {
          method: 'POST',
          headers: { 'X-Dev-Guardian-Id': 'g1' },
        })
      ).status,
    ).toBe(401);
    expect((await register('forged', 'c_one', { ownerId: 'c_two' })).status).toBe(400);
  });
  it('registers idempotently, returning only a device id and never logging tokens', async () => {
    const token = 'synthetic-private-token';
    const first = await register(token);
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(await first.json()).toEqual({ deviceId: id(token) });
    expect((await register(token)).status).toBe(201);
    expect((await db.doc(`families/f_test/devices/${id(token)}`).get()).data()).toMatchObject({
      ownerType: 'child',
      ownerId: 'c_one',
      fcmToken: token,
    });
    expect(logs.join('\n')).not.toContain(token);
  });
  it('rejects token takeover by another child, family or a guardian-owned device', async () => {
    expect((await register('shared')).status).toBe(201);
    expect((await register('shared', 'c_two')).status).toBe(403);
    expect((await register('shared', 'other')).status).toBe(403);
    await db
      .doc(`families/f_test/devices/${id('guardian')}`)
      .set({ ownerType: 'guardian', ownerId: 'g1', fcmToken: 'guardian' });
    expect((await register('guardian')).status).toBe(403);
    expect(
      (
        await app.request(`/v1/child/devices/${id('shared')}`, {
          method: 'DELETE',
          headers: { ...headers, 'X-Dev-Child-Id': 'c_two' },
        })
      ).status,
    ).toBe(403);
    expect((await db.doc(`families/f_test/devices/${id('shared')}`).get()).exists).toBe(true);
  });
  it('rejects invalid tokens and inactive accounts', async () => {
    expect((await register('bad token')).status).toBe(400);
    await db.doc('families/f_test/children/c_two').update({ status: 'paused' });
    expect((await register('paused', 'c_two')).status).toBe(403);
    await db.doc('families/f_test/children/c_two').update({ status: 'active' });
  });
  it('revokes idempotently even after the child is paused, allowing a subsequent re-pair', async () => {
    expect((await register('revoke')).status).toBe(201);
    await db.doc('families/f_test/children/c_one').update({ status: 'paused' });
    for (let i = 0; i < 2; i++)
      expect(
        (await app.request(`/v1/child/devices/${id('revoke')}`, { method: 'DELETE', headers }))
          .status,
      ).toBe(204);
    expect((await db.doc(`families/f_test/devices/${id('revoke')}`).get()).exists).toBe(false);
    expect((await register('revoke', 'c_two')).status).toBe(201);
    await db.doc('families/f_test/children/c_one').update({ status: 'active' });
  });
});
