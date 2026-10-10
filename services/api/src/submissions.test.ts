import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory, FirestoreSessionService, ScriptedLlm } from '@ijime/agent-core';
import type { ArtworkRes, HomeCheckinRes, IslandRes, MoodRes } from '@ijime/api-types';
import {
  createNoModelDetector,
  CrisisDetector,
  KeywordMatcher,
  ModelCallError,
} from '@ijime/crisis-detector';
import { FsKbSource, Kb, lexiconSchema } from '@ijime/kb-loader';
import { encodePushEnvelope, Logger, MemoryPublisher } from '@ijime/service-kit';
import { createApp as createSignalWorkerApp } from '@ijime/signal-worker/src/app.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { MemoryArtworkImages, type ArtworkFeatureRequest } from './artwork-io.js';
import { createApiRuntime } from './runtime.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SENTINEL = 'SENTINEL_ねこと うみに いった';
const FEATURES = {
  selfPresent: true,
  selfSizeRatio: 0.3,
  othersCount: 1,
  nearestOtherDist: 0.2,
  isolated: false,
  explicitHarm: false,
};

let db: Firestore;
let directory: DevChildDirectory;
let app: ReturnType<typeof createApp>;
let images: MemoryArtworkImages;
let signalWorker: ReturnType<typeof createSignalWorkerApp>;
const published: { topic: string; payload: Record<string, unknown> }[] = [];
const featureCalls: ArtworkFeatureRequest[] = [];
const logLines: string[] = [];
let failFeatures = false;

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

const H = (childId: string) => ({ 'X-Dev-Child-Id': childId });
const J = (childId: string) => ({ ...H(childId), 'Content-Type': 'application/json' });
const base = async (childId: string) => {
  const child = await directory.lookup(childId);
  return `families/${child.familyId}/children/${childId}`;
};

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  directory = new DevChildDirectory(db);
  const sessions = new FirestoreSessionService(db, directory);
  images = new MemoryArtworkImages();
  const logger = new Logger('test', (l) => logLines.push(l));

  const swLlm = new ScriptedLlm(() => ({ text: JSON.stringify(FEATURES) }), { model: 'sw' });
  signalWorker = createSignalWorkerApp(
    async () => ({
      db,
      kb,
      sessions,
      directory,
      publisher: new MemoryPublisher(),
      model: swLlm,
      artworkModel: swLlm,
      detector: createNoModelDetector(await kb.yaml('lexicon/ja.yaml', lexiconSchema)),
      logger,
      now: () => new Date(),
    }),
    logger,
  );

  const rt = await createApiRuntime({
    kb,
    db,
    directory,
    sessions,
    logger,
    publish: async (topic, payload) => void published.push({ topic, payload }),
    auth: { allowDevHeader: true },
    images,
    artworkFeatures: async (req) => {
      featureCalls.push(req);
      if (failFeatures) throw new Error('signal-worker down');
      const res = await signalWorker.request('/internal/artworks/features', {
        method: 'POST',
        body: JSON.stringify(req),
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.status !== 204) throw new Error(`status ${res.status}`);
    },
  });
  app = createApp({
    getKb: async () => kb,
    allowedOrigins: [],
    submissions: async () => rt.submissions,
  });
});
afterAll(() => db.terminate());
beforeEach(() => {
  published.length = 0;
  featureCalls.length = 0;
  failFeatures = false;
});

describe('POST /v1/child/mood and /home-checkins', () => {
  it('records the mood, replies with the fixed copy, and publishes checkin.created', async () => {
    expect((await app.request('/v1/child/mood', { method: 'POST' })).status).toBe(401);
    const res = await app.request('/v1/child/mood', {
      method: 'POST',
      headers: J('c_sub_mood'),
      body: JSON.stringify({ weather: 'rainy' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as MoodRes;
    expect(body.petReply).toBe('教えてくれてありがとう。話したくなったら、いつでも聞いてるよ。');
    const doc = (
      await db.doc(`${await base('c_sub_mood')}/moodCheckins/${body.checkinId}`).get()
    ).data()!;
    expect(doc).toMatchObject({ weather: 'rainy' });
    expect(doc['localDate']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(published).toEqual([
      {
        topic: 'checkin.created',
        payload: { childId: 'c_sub_mood', kind: 'mood', checkinId: body.checkinId },
      },
    ]);

    // 同じイベントを signal-worker に渡す：M-MOOD-001 が生成される
    await signalWorker.request('/internal/events/checkin-created', {
      method: 'POST',
      body: JSON.stringify(encodePushEnvelope(published[0]!.payload)),
      headers: { 'Content-Type': 'application/json' },
    });
    const signals = await db.collection(`${await base('c_sub_mood')}/signals`).get();
    expect(signals.docs.map((d) => [d.get('signalDefId'), d.get('metric.value')])).toEqual([
      ['M-MOOD-001', 1],
    ]);

    const bad = await app.request('/v1/child/mood', {
      method: 'POST',
      headers: J('c_sub_mood'),
      body: JSON.stringify({ weather: 'snowy' }),
    });
    expect(bad.status).toBe(400);
  });

  it('refuses a geo check-in when home check-in is off, but accepts a manual one', async () => {
    const path = await base('c_sub_home');
    await db.doc(path).update({ 'dataSources.home_checkin': false });
    const geo = await app.request('/v1/child/home-checkins', {
      method: 'POST',
      headers: J('c_sub_home'),
      body: JSON.stringify({ atHome: true, method: 'geo' }),
    });
    expect(geo.status).toBe(403);
    expect(((await geo.json()) as { error: { code: string } }).error.code).toBe(
      'DATA_SOURCE_DISABLED',
    );
    const manual = await app.request('/v1/child/home-checkins', {
      method: 'POST',
      headers: J('c_sub_home'),
      body: JSON.stringify({ atHome: true, method: 'manual' }),
    });
    expect(manual.status).toBe(201);
    const body = (await manual.json()) as HomeCheckinRes;
    expect(body.greeting).toBe('おかえり！今日はどんな日だった？');
    const doc = (await db.doc(`${path}/homeCheckins/${body.checkinId}`).get()).data()!;
    expect(doc).toMatchObject({ atHome: true, method: 'manual' });
    expect(Object.keys(doc).sort()).toEqual(['atHome', 'checkinAt', 'localDate', 'method']);
  });
});

function artworkForm(fields: Record<string, string>, image: Buffer = png(800, 600)): FormData {
  const form = new FormData();
  form.set('image', new File([new Uint8Array(image)], 'a.png', { type: 'image/png' }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

async function postArtwork(childId: string, fields: Record<string, string>, image?: Buffer) {
  return app.request('/v1/child/artworks', {
    method: 'POST',
    headers: H(childId),
    body: artworkForm(fields, image),
  });
}

describe('POST /v1/child/artworks', () => {
  it('stores the encrypted narrative, saves the image only when asked, and extracts features in the request', async () => {
    const path = await base('c_sub_art1');
    await db.doc(path).update({ 'dataSources.artwork_save': true });
    const res = await postArtwork('c_sub_art1', {
      type: 'story',
      promptId: 'sp_001',
      narrativeText: SENTINEL,
      narrativeMode: 'typed',
      save: 'true',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ArtworkRes;
    expect(body).toEqual({
      artworkId: body.artworkId,
      petPrompt: 'お話をありがとう！続きも聞かせてね。',
    });

    const imagePath = `${path}/artworks/${body.artworkId}.png`;
    expect(images.saved.has(imagePath)).toBe(true);
    expect(featureCalls).toHaveLength(1);
    expect(featureCalls[0]!.image.data).toBe(png(800, 600).toString('base64'));

    const doc = (await db.doc(`${path}/artworks/${body.artworkId}`).get()).data()!;
    expect(doc).toMatchObject({
      type: 'story',
      promptId: 'sp_001',
      imageRef: imagePath,
      featureStatus: 'done',
      features: FEATURES,
      sharedWithGuardian: false,
    });
    expect(Buffer.from(doc['narrativeEnc']).toString('utf8')).not.toContain('SENTINEL');
    const signals = await db.collection(`${path}/signals`).get();
    expect(signals.docs.map((d) => d.get('signalDefId')).sort()).toEqual([
      'D-ISO-001',
      'D-NEAR-001',
      'D-SELF-001',
    ]);
    // 絵の作品では artwork.created を発行しない（イベントの代わりに内部呼び出しを使う）
    expect(published).toEqual([]);

    const share = await app.request(`/v1/child/artworks/${body.artworkId}/share`, {
      method: 'POST',
      headers: H('c_sub_art1'),
    });
    expect(share.status).toBe(204);
    expect(
      (await db.doc(`${path}/artworks/${body.artworkId}`).get()).get('sharedWithGuardian'),
    ).toBe(true);
    expect([...logLines].join('\n')).not.toContain(SENTINEL);
  });

  it('does not save the image when artwork saving is off, so it cannot be shared', async () => {
    const res = await postArtwork('c_sub_art2', {
      type: 'self_portrait',
      narrativeMode: 'typed',
      save: 'true',
    });
    expect(res.status).toBe(201);
    const { artworkId } = (await res.json()) as ArtworkRes;
    const doc = (await db.doc(`${await base('c_sub_art2')}/artworks/${artworkId}`).get()).data()!;
    expect(doc).not.toHaveProperty('imageRef');
    expect(doc).not.toHaveProperty('narrativeEnc');
    const share = await app.request(`/v1/child/artworks/${artworkId}/share`, {
      method: 'POST',
      headers: H('c_sub_art2'),
    });
    expect(share.status).toBe(400);
  });

  it('answers with the crisis payload and skips feature extraction when the narrative hits', async () => {
    const res = await postArtwork('c_sub_art3', {
      type: 'story',
      narrativeText: 'もう死にたい',
      narrativeMode: 'voice_transcript',
      save: 'false',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as ArtworkRes;
    expect(body.crisis?.message).toBeTruthy();
    expect(body.crisis?.resources.map((r) => r.id).sort()).toEqual([
      'childline',
      'emergency',
      'sos_dial',
    ]);
    expect(featureCalls).toHaveLength(0);

    const path = await base('c_sub_art3');
    const crisis = (await db.doc(`${path}/crisisEvents/${body.crisis!.crisisId}`).get()).data()!;
    expect(crisis).toMatchObject({
      triggerType: 'artwork',
      sourceRef: `${path}/artworks/${body.artworkId}`,
      status: 'open',
    });
    expect(JSON.stringify(crisis)).not.toContain('死にたい');
    expect((await db.doc(`${path}/artworks/${body.artworkId}`).get()).get('featureStatus')).toBe(
      'skipped',
    );
    expect(published).toEqual([
      {
        topic: 'crisis.detected',
        payload: {
          childId: 'c_sub_art3',
          crisisId: body.crisis!.crisisId,
          category: 'other',
          familyHarmSuspected: false,
        },
      },
    ]);
  });

  it('rejects an unmatched narrative with 503 and the fixed reply when models are down, storing nothing', async () => {
    const quota = async () => {
      throw new ModelCallError('quota');
    };
    const rt = await createApiRuntime({
      kb: await Kb.load(new FsKbSource(KB_DIR)),
      db,
      directory,
      logger: new Logger('test', (l) => logLines.push(l)),
      publish: async (topic, payload) => void published.push({ topic, payload }),
      auth: { allowDevHeader: true },
      images,
      artworkFeatures: async (req) => void featureCalls.push(req),
      detector: new CrisisDetector(
        new KeywordMatcher(['死にたい']),
        { screen: quota },
        { review: quota },
        { screenTimeoutMs: 200, reviewTimeoutMs: 200, random: () => 0 },
      ),
    });
    const down = createApp({
      getKb: async () => rt.kb,
      allowedOrigins: [],
      submissions: async () => rt.submissions,
    });
    const res = await down.request('/v1/child/artworks', {
      method: 'POST',
      headers: H('c_sub_art_down'),
      body: artworkForm({
        type: 'story',
        narrativeText: SENTINEL,
        narrativeMode: 'typed',
        save: 'false',
      }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: { code: 'MODEL_UNAVAILABLE', message: rt.chat.pausedReplies.high },
    });
    const artworks = await db.collection(`${await base('c_sub_art_down')}/artworks`).get();
    expect(artworks.size).toBe(0);
    expect(featureCalls).toHaveLength(0);
    expect(published).toEqual([]);
  });

  it('still succeeds when signal-worker fails, and rejects bad images and fields', async () => {
    failFeatures = true;
    const ok = await postArtwork('c_sub_art4', {
      type: 'self_portrait',
      narrativeMode: 'typed',
      save: 'false',
    });
    expect(ok.status).toBe(201);
    expect(featureCalls).toHaveLength(1);

    const fields = { type: 'self_portrait', narrativeMode: 'typed', save: 'false' };
    expect((await postArtwork('c_sub_art4', fields, Buffer.from('GIF89a'))).status).toBe(400);
    expect((await postArtwork('c_sub_art4', fields, png(2048, 100))).status).toBe(400);
    expect((await postArtwork('c_sub_art4', { ...fields, type: 'island' })).status).toBe(400);
    expect(
      (await postArtwork('c_sub_art4', { ...fields, narrativeText: 'あ'.repeat(501) })).status,
    ).toBe(400);
  });
});

const item = (id: string, catalogId: string, category: string, x: number, y: number) => ({
  id,
  catalogId,
  category,
  x,
  y,
  rotation: 0,
  layer: 0,
});

describe('POST /v1/child/island-scenes', () => {
  const items = [
    item('me', 'rabbit_small', 'animal', 0.4, 0.5),
    item('b', 'bear', 'animal', 0.6, 0.5),
  ];

  async function postIsland(childId: string, body: unknown) {
    return app.request('/v1/child/island-scenes', {
      method: 'POST',
      headers: J(childId),
      body: JSON.stringify(body),
    });
  }

  it('validates the self figure and the catalog', async () => {
    expect((await postIsland('c_sub_isl1', { selfFigureId: 'x', items })).status).toBe(400);
    expect(
      (
        await postIsland('c_sub_isl1', {
          selfFigureId: 'me',
          items: [...items, item('z', 'dragon', 'animal', 0.1, 0.1)],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await postIsland('c_sub_isl1', {
          selfFigureId: 'me',
          items: [item('me', 'rabbit_small', 'animal', 1.5, 0.5)],
        })
      ).status,
    ).toBe(400);
  });

  it('stores the encrypted scene graph, publishes artwork.created, and signal-worker computes features', async () => {
    const res = await postIsland('c_sub_isl2', {
      selfFigureId: 'me',
      items,
      narrative: { mode: 'typed', text: SENTINEL },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as IslandRes;
    expect(body).toEqual({
      sceneId: body.sceneId,
      petPrompt: 'すてきな島だね！また遊びに行こうね。',
    });
    const path = await base('c_sub_isl2');
    const doc = (await db.doc(`${path}/islandScenes/${body.sceneId}`).get()).data()!;
    expect(doc['selfFigureId']).toBe('me');
    expect(Buffer.from(doc['sceneGraphEnc']).toString('utf8')).not.toContain('rabbit_small');
    expect(published).toEqual([
      {
        topic: 'artwork.created',
        payload: { childId: 'c_sub_isl2', artworkId: body.sceneId, type: 'island' },
      },
    ]);

    await signalWorker.request('/internal/events/artwork-created', {
      method: 'POST',
      body: JSON.stringify(encodePushEnvelope(published[0]!.payload)),
      headers: { 'Content-Type': 'application/json' },
    });
    const features = (await db.doc(`${path}/islandScenes/${body.sceneId}`).get()).get('features');
    expect(features).toMatchObject({ selfToNearestDist: 0.2, isolated: false, enclosed: false });
    expect(logLines.join('\n')).not.toContain(SENTINEL);
  });

  it('answers with the crisis payload and publishes no artwork.created when the narrative hits', async () => {
    const res = await postIsland('c_sub_isl3', {
      selfFigureId: 'me',
      items,
      narrative: { mode: 'voice_transcript', text: '死にたい' },
    });
    const body = (await res.json()) as IslandRes;
    expect(body.crisis?.crisisId).toBeTruthy();
    expect(published.map((p) => p.topic)).toEqual(['crisis.detected']);
    const crisis = (
      await db.doc(`${await base('c_sub_isl3')}/crisisEvents/${body.crisis!.crisisId}`).get()
    ).data()!;
    expect(crisis['triggerType']).toBe('island');
  });
});
