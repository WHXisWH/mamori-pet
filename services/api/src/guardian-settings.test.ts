import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

let db: Firestore;
let app: ReturnType<typeof createApp>;
const headers = { 'X-Dev-Guardian-Id': 'g_settings', 'Content-Type': 'application/json' };
const path = '/v1/guardians/me/notify-settings';
beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-guardian-settings-${Date.now()}` });
  for (const [family, guardian] of [
    ['f_settings', 'g_settings'],
    ['f_other', 'g_other'],
  ]) {
    await db.doc(`families/${family}`).set({ status: 'active' });
    await db.doc(`families/${family}/guardians/${guardian}`).set({
      guardianId: guardian,
      role: 'primary',
      email: `${guardian}@example.test`,
      notifyChannels: ['webpush'],
      privateMetadata: 'PRIVATE',
    });
  }
  app = createApp({
    getKb: async () => {
      throw new Error('unused');
    },
    allowedOrigins: [],
    guardian: async () => ({ db, auth: { allowDevHeader: true } }),
  });
});
afterAll(() => db.terminate());

describe('guardian notification contacts', () => {
  it.each([
    ['revoked', { role: 'primary', revokedAt: new Date() }],
    ['paused', { role: 'primary', status: 'paused' }],
    ['deleted', { role: 'primary', status: 'deleted' }],
    ['invalid-status', { role: 'primary', status: null }],
    ['invalid-role', { role: 'child', status: 'active' }],
    ['missing-role', { status: 'active' }],
  ])('rejects %s guardians on settings and device operations', async (name, membership) => {
    const familyId = `f_denied_${name}`;
    const guardianId = `g_denied_${name}`;
    const ref = db.doc(`families/${familyId}/guardians/${guardianId}`);
    await db.doc(`families/${familyId}`).set({ status: 'active' });
    await ref.set({ guardianId, notifyChannels: ['webpush'], ...membership });
    const before = (await ref.get()).data();
    const deniedHeaders = { ...headers, 'X-Dev-Guardian-Id': guardianId };
    expect.soft((await app.request(path, { headers: deniedHeaders })).status).toBe(403);
    expect
      .soft(
        (
          await app.request(path, {
            method: 'PUT',
            headers: deniedHeaders,
            body: JSON.stringify({ channels: ['email'] }),
          })
        ).status,
      )
      .toBe(403);
    expect
      .soft(
        (
          await app.request('/v1/devices', {
            method: 'POST',
            headers: deniedHeaders,
            body: JSON.stringify({ fcmToken: `denied-${name}`, platform: 'desktop' }),
          })
        ).status,
      )
      .toBe(403);
    expect.soft((await ref.get()).data()).toEqual(before);
    expect.soft((await db.collection(`families/${familyId}/devices`).get()).empty).toBe(true);
  });
  it.each(['primary', 'secondary'])('allows %s contacts after consent withdrawal', async (role) => {
    const familyId = `f_withdrawn_${role}`;
    const guardianId = `g_withdrawn_${role}`;
    await db.doc(`families/${familyId}`).set({ status: 'active', consentComplete: false });
    await db.doc(`families/${familyId}/guardians/${guardianId}`).set({
      guardianId,
      role,
      revokedAt: null,
      ...(role === 'primary' ? { status: 'active' } : {}),
    });
    const memberHeaders = { ...headers, 'X-Dev-Guardian-Id': guardianId };
    expect((await app.request(path, { headers: memberHeaders })).status).toBe(200);
    expect(
      (
        await app.request(path, {
          method: 'PUT',
          headers: memberHeaders,
          body: JSON.stringify({ channels: ['email'] }),
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await app.request('/v1/devices', {
          method: 'POST',
          headers: memberHeaders,
          body: JSON.stringify({ fcmToken: `withdrawn-${role}`, platform: 'desktop' }),
        })
      ).status,
    ).toBe(201);
  });
  it('requires authentication and returns only the current guardian settings', async () => {
    expect((await app.request(path)).status).toBe(401);
    const response = await app.request(path, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ channels: ['webpush'] });
  });
  it('persists channels and the contact used by notifier, without marking it verified', async () => {
    const response = await app.request(path, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ channels: ['webpush', 'sms', 'sms'], phoneE164: '+819012345678' }),
    });
    expect(response.status).toBe(204);
    expect(await (await app.request(path, { headers })).json()).toEqual({
      channels: ['webpush', 'sms'],
      phoneE164: '+819012345678',
    });
    const guardian = await db.doc('families/f_settings/guardians/g_settings').get();
    expect(guardian.get('notifyChannels')).toEqual(['webpush', 'sms']);
    expect(guardian.get('phoneVerifiedAt')).toBeUndefined();
    expect(
      (await db.doc('families/f_other/guardians/g_other').get()).get('phoneE164'),
    ).toBeUndefined();
  });
  it.each([
    { channels: ['sms'] },
    { channels: ['sms'], phoneE164: '09012345678' },
    { channels: ['sms'], phoneE164: '+16505550123' },
    { channels: ['bogus'] },
    { channels: ['email'], guardianId: 'g_other' },
  ])('rejects invalid settings %j', async (body) => {
    expect(
      (await app.request(path, { method: 'PUT', headers, body: JSON.stringify(body) })).status,
    ).toBe(400);
  });
  it('removes the phone when omitted from replacement settings', async () => {
    expect(
      (await app.request(path, { method: 'PUT', headers, body: JSON.stringify({ channels: [] }) }))
        .status,
    ).toBe(204);
    expect(await (await app.request(path, { headers })).json()).toEqual({ channels: [] });
    expect(
      (await db.doc('families/f_settings/guardians/g_settings').get()).get('phoneE164'),
    ).toBeUndefined();
  });
  it('registers a push device idempotently with server-owned identity and hides its token', async () => {
    const body = { fcmToken: 'LOCAL_SYNTHETIC_PUSH_TOKEN', platform: 'desktop' };
    const post = () =>
      app.request('/v1/devices', { method: 'POST', headers, body: JSON.stringify(body) });
    const first = await post();
    expect(first.status).toBe(201);
    const result = (await first.json()) as { deviceId: string };
    expect(Object.keys(result)).toEqual(['deviceId']);
    expect(await (await post()).json()).toEqual(result);
    const devices = await db.collection('families/f_settings/devices').get();
    expect(devices.size).toBe(1);
    expect(devices.docs[0]!.data()).toMatchObject({
      ownerType: 'guardian',
      ownerId: 'g_settings',
      fcmToken: body.fcmToken,
      platform: 'desktop',
    });
    expect(
      (
        await app.request('/v1/devices', {
          method: 'POST',
          headers: { ...headers, 'X-Dev-Guardian-Id': 'g_other' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/v1/devices', {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, ownerId: 'g_other' }),
        })
      ).status,
    ).toBe(400);
  });
  it('does not access or update contacts after a family is disabled', async () => {
    await db.doc('families/f_other').update({ status: 'deleting' });
    const other = { ...headers, 'X-Dev-Guardian-Id': 'g_other' };
    expect((await app.request(path, { headers: other })).status).toBe(403);
    expect(
      (
        await app.request(path, {
          method: 'PUT',
          headers: other,
          body: JSON.stringify({ channels: ['email'] }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/v1/devices', {
          method: 'POST',
          headers: other,
          body: JSON.stringify({ fcmToken: 'new-token', platform: 'desktop' }),
        })
      ).status,
    ).toBe(403);
  });
});
