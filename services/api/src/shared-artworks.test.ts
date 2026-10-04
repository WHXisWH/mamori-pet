import { randomUUID } from 'node:crypto';

import { FieldValue, Firestore } from '@google-cloud/firestore';
import type { SharedArtworksRes } from '@ijime/api-types';
import { createServiceApp, Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { MemoryArtworkImages } from './artwork-io.js';
import { registerSubmissions, type SubmissionDeps } from './routes/submissions.js';

let db: Firestore;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',
  'base64',
);

beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-art-${randomUUID().slice(0, 8)}` });
});
afterAll(() => db.terminate());

async function fixture(withGallery = true) {
  const id = randomUUID().replaceAll('-', '');
  const familyId = `f_${id}`;
  const childId = `c_${id}`;
  const guardianId = `g_${id}`;
  const base = `families/${familyId}/children/${childId}`;
  const imageRef = `${base}/artworks/a.png`;
  const now = new Date();
  const images = new MemoryArtworkImages();
  await images.save(imageRef, PNG);
  await db.doc(`families/${familyId}`).set({ status: 'active', consentComplete: true });
  await db.doc(`families/${familyId}/guardians/${guardianId}`).set({ guardianId, role: 'primary' });
  await db.doc(base).set({ childId, familyId, status: 'active' });
  const artwork = db.doc(`${base}/artworks/a`);
  await artwork.set({
    type: 'story',
    imageRef,
    sharedWithGuardian: false,
    createdAt: now,
    expireAt: new Date(now.getTime() + 86_400_000),
    narrativeEnc: Buffer.from('PRIVATE NARRATIVE'),
    features: { isolated: true },
    level: 'l4',
    interpretation: 'PRIVATE INTERPRETATION',
  });
  const logs: string[] = [];
  const logger = new Logger('shared-test', (line) => logs.push(line));
  const deps = {
    db,
    images,
    auth: { allowDevHeader: true },
    now: () => new Date(),
    logger,
    directory: { lookup: async () => ({ childId, familyId, petId: 'pet', dek: Buffer.alloc(32) }) },
  } as unknown as SubmissionDeps;
  const app = createServiceApp({ name: 'shared-test', logger });
  registerSubmissions(app, async () => deps);
  if (withGallery) {
    const { registerSharedArtworks } = await import('./routes/shared-artworks.js');
    registerSharedArtworks(app, async () => deps);
  }
  const childHeaders = { 'X-Dev-Child-Id': childId };
  const guardianHeaders = { 'X-Dev-Guardian-Id': guardianId };
  const share = (method = 'POST') =>
    app.request('/v1/child/artworks/a/share', { method, headers: childHeaders });
  const list = (query = '') =>
    app.request(`/v1/children/${childId}/shared-artworks${query}`, { headers: guardianHeaders });
  return {
    app,
    deps,
    base,
    familyId,
    childId,
    guardianId,
    artwork,
    imageRef,
    images,
    share,
    list,
    logs,
    childHeaders,
    guardianHeaders,
  };
}

describe('explicit artwork sharing', () => {
  it('share rejects an expired saved image', async () => {
    const f = await fixture(false);
    await f.artwork.update({ expireAt: new Date(1) });
    expect((await f.share()).status).toBe(404);
    expect((await f.artwork.get()).get('sharedWithGuardian')).toBe(false);
  });

  it('share rejects unsafe family crises and path substitution', async () => {
    const f = await fixture(false);
    await f.artwork.update({ imageRef: `families/other/children/private/artworks/a.png` });
    expect((await f.share()).status).toBe(400);
    await f.artwork.update({ imageRef: f.imageRef });
    await db
      .doc(`${f.base}/crisisEvents/unsafe`)
      .set({ status: 'open', familyHarmSuspected: true });
    expect((await f.share()).status).toBe(403);
  });

  it('projects only explicitly shared images and revocation blocks subsequent reads', async () => {
    const f = await fixture();
    expect(await (await f.list()).json()).toEqual({ items: [] });
    expect((await f.share()).status).toBe(204);
    const sharedAt = (await f.artwork.get()).get('sharedAt');
    expect((await f.share()).status).toBe(204);
    expect((await f.artwork.get()).get('sharedAt')).toEqual(sharedAt);
    const res = await f.list();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as SharedArtworksRes;
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0]!).sort()).toEqual([
      'artworkId',
      'imageUrl',
      'sharedAt',
      'type',
    ]);
    expect(body.items[0]!.imageUrl).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(JSON.stringify(body)).not.toMatch(
      /PRIVATE|narrative|features|interpretation|level|risk/i,
    );
    expect((await f.share('DELETE')).status).toBe(204);
    expect((await f.share('DELETE')).status).toBe(204);
    expect((await f.artwork.get()).get('sharedAt')).toBeUndefined();
    expect(await (await f.list()).json()).toEqual({ items: [] });
    expect(f.logs.join('\n')).not.toMatch(/PRIVATE|data:image/);
  });

  it('rejects unauthenticated/cross-family readers and inactive guardians or children', async () => {
    const f = await fixture();
    await f.share();
    const url = `/v1/children/${f.childId}/shared-artworks`;
    expect((await f.app.request(url)).status).toBe(401);
    await db
      .doc('families/foreign/guardians/foreign')
      .set({ guardianId: 'foreign', role: 'primary' });
    expect((await f.app.request(url, { headers: { 'X-Dev-Guardian-Id': 'foreign' } })).status).toBe(
      404,
    );
    const g = db.doc(`families/${f.familyId}/guardians/${f.guardianId}`);
    for (const status of ['inactive', 'revoked', 'deleting']) {
      await g.update({ status });
      expect((await f.list()).status).toBe(403);
    }
    await g.update({ status: 'active', revokedAt: new Date() });
    expect((await f.list()).status).toBe(403);
    await g.update({ revokedAt: FieldValue.delete() });
    await db.doc(f.base).update({ status: 'paused' });
    expect((await f.list()).status).toBe(404);
    expect((await f.share()).status).toBe(403);
  });

  it.each(['open', 'guardian_acknowledged', 'unknown', undefined])(
    'suppresses unsafe crisis status %s, without issuing URLs',
    async (status) => {
      const f = await fixture();
      await f.share();
      const read = vi.spyOn(f.images, 'readUrl');
      await db
        .doc(`${f.base}/crisisEvents/safe`)
        .set({ status: 'open', familyHarmSuspected: false });
      await db
        .doc(`${f.base}/crisisEvents/unsafe`)
        .set({ ...(status ? { status } : {}), familyHarmSuspected: true });
      expect(await (await f.list()).json()).toEqual({ items: [] });
      expect(read).not.toHaveBeenCalled();
      expect((await f.share('DELETE')).status).toBe(204);
    },
  );

  it('rejects withdrawn guardian consent for consent-required children', async () => {
    const f = await fixture();
    await f.share();
    await db.doc(f.base).update({ requiresGuardianConsent: true });
    await db.doc(`families/${f.familyId}`).update({ consentComplete: false });
    const read = vi.spyOn(f.images, 'readUrl');
    expect((await f.list()).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it('omits unsaved, unshared, expired, malformed and foreign-path rows', async () => {
    const f = await fixture();
    await f.share();
    const original = (await f.artwork.get()).data()!;
    for (const [name, patch] of Object.entries({
      unshared: { sharedWithGuardian: false },
      unsaved: { imageRef: null },
      expired: { expireAt: new Date(1) },
      absentExpiry: { expireAt: null },
      missingShareTime: { sharedAt: null },
      foreign: { imageRef: 'families/foreign/a.png' },
      unsafePath: { imageRef: `${f.base}/artworks/../a.png` },
      invalidType: { type: 'risk_report' },
    }))
      await db
        .doc(`${f.base}/artworks/${name}`)
        .set({ ...original, imageRef: `${f.base}/artworks/${name}.png`, ...patch });
    const read = vi.spyOn(f.images, 'readUrl');
    expect(
      ((await (await f.list()).json()) as SharedArtworksRes).items.map((x) => x.artworkId),
    ).toEqual(['a']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![1].getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it.each(['unshare', 'expire', 'child', 'guardian', 'crisis'])(
    'rechecks %s after async image lookup before returning a URL',
    async (kind) => {
      const f = await fixture();
      await f.share();
      vi.spyOn(f.images, 'readUrl').mockImplementation(async () => {
        if (kind === 'unshare') await f.artwork.update({ sharedWithGuardian: false });
        if (kind === 'expire') await f.artwork.update({ expireAt: new Date(1) });
        if (kind === 'child') await db.doc(f.base).update({ status: 'deleting' });
        if (kind === 'guardian')
          await db.doc(`families/${f.familyId}/guardians/${f.guardianId}`).delete();
        if (kind === 'crisis')
          await db
            .doc(`${f.base}/crisisEvents/race`)
            .set({ status: 'open', familyHarmSuspected: true });
        return 'https://storage.example.test/private-signed-url';
      });
      const res = await f.list();
      expect(await res.text()).not.toContain('private-signed-url');
    },
  );

  it('bounds pagination, supports old write-only image adapters and rejects injection IDs', async () => {
    const f = await fixture();
    await f.share();
    expect((await f.list('?pageSize=0')).status).toBe(400);
    expect((await f.list('?pageToken=..%2Fother')).status).toBe(400);
    expect(
      (
        await f.app.request('/v1/child/artworks/..%2Fother/share', {
          method: 'POST',
          headers: f.childHeaders,
        })
      ).status,
    ).toBe(400);
    const page = (await (await f.list('?pageSize=1')).json()) as SharedArtworksRes;
    expect(page.items).toHaveLength(1);
    expect(await (await f.list(`?pageSize=1&pageToken=${page.nextPageToken}`)).json()).toEqual({
      items: [],
    });
    f.deps.images = { save: async () => {} };
    expect((await f.list()).status).toBe(503);
  });
});
