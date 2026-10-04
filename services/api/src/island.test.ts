import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory, FirestoreSessionService } from '@ijime/agent-core';
import type {
  ChildHomeRes,
  IslandPutRes,
  IslandStateRes,
  PetRequestCompleteRes,
  PetRequestsRes,
  RitualRes,
} from '@ijime/api-types';
import { island as islandConfig } from '@ijime/config';
import { fieldAad } from '@ijime/crypto';
import { FsKbSource, Kb, loadGames, seasonFor } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { MemoryArtworkImages } from './artwork-io.js';
import { createApiRuntime, type ApiRuntime } from './runtime.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SENTINEL = 'SENTINEL_しまの おはなし';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',
  'base64',
);

let db: Firestore;
let directory: DevChildDirectory;
let sessions: FirestoreSessionService;
let images: MemoryArtworkImages;
let rt: ApiRuntime;
let app: ReturnType<typeof createApp>;
const published: { topic: string; payload: Record<string, unknown> }[] = [];
const logLines: string[] = [];
const START = new Date();
const DAY = 86_400_000;
const jstDate = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const TODAY = jstDate(START);
const YESTERDAY = jstDate(new Date(START.getTime() - DAY));
let clock = START;
let season = '';

const J = (childId: string) => ({ 'X-Dev-Child-Id': childId, 'Content-Type': 'application/json' });
const call = (childId: string, path: string, method = 'GET', body?: unknown) =>
  app.request(`/v1/child${path}`, {
    method,
    headers: J(childId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const base = async (childId: string) => {
  const child = await directory.lookup(childId);
  return { child, base: `families/${child.familyId}/children/${childId}` };
};
const item = (id: string, catalogId: string, category: string, x: number, y: number) => ({
  id,
  catalogId,
  category,
  x,
  y,
  rotation: 0,
  layer: 0,
});
const items = [
  item('me', 'rabbit_small', 'animal', 0.4, 0.5),
  item('b', 'bear', 'animal', 0.6, 0.5),
];

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime-island' });
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  season = seasonFor((await loadGames(kb)).seasons, START);
  directory = new DevChildDirectory(db);
  sessions = new FirestoreSessionService(db, directory);
  images = new MemoryArtworkImages();
  rt = await createApiRuntime({
    kb,
    db,
    directory,
    sessions,
    logger: new Logger('test', (l) => logLines.push(l)),
    publish: async (topic, payload) => void published.push({ topic, payload }),
    auth: { allowDevHeader: true },
    images,
    artworkFeatures: async () => {},
    now: () => clock,
  });
  app = createApp({
    getKb: async () => kb,
    allowedOrigins: [],
    chat: async () => rt.chat,
    submissions: async () => rt.submissions,
  });
});
afterAll(() => db.terminate());
beforeEach(() => {
  published.length = 0;
  clock = START;
});

async function offer(childId: string, type: string, promptId: string, rewardItemId: string) {
  const { base: b } = await base(childId);
  const ref = db.collection(`${b}/petRequests`).doc();
  await ref.set({
    type,
    promptId,
    rewardItemId,
    status: 'offered',
    offeredAt: clock,
    expiresAt: new Date(clock.getTime() + 7 * 86_400_000),
  });
  return ref;
}

async function savedDrawing(childId: string, type = 'drawing') {
  const { base: b } = await base(childId);
  const ref = db.collection(`${b}/artworks`).doc();
  const imageRef = `${b}/artworks/${ref.id}.png`;
  await images.save(imageRef, PNG);
  await ref.set({
    type,
    imageRef,
    features: {},
    featureModel: '',
    featureStatus: 'done',
    sharedWithGuardian: false,
    createdAt: clock,
    expireAt: new Date(clock.getTime() + 86_400_000),
  });
  return ref;
}

describe('GET/PUT /v1/child/island', () => {
  it('starts empty with the default catalog unlocked and counts visit days by JST date', async () => {
    const first = (await (await call('c_isl_get', '/island')).json()) as IslandStateRes;
    expect(first).toMatchObject({
      items: [],
      decorations: [],
      unlockedItems: [],
      visitDays: 1,
      stage: 1,
      season,
      goodThingCount: 0,
    });
    expect(first.catalog.find((c) => c.catalogId === 'bear')).toEqual({
      catalogId: 'bear',
      category: 'animal',
      label: 'くま',
      spriteUrl: '/island/bear_01',
      locked: false,
    });
    expect(
      first.catalog.filter(
        (c) => c.catalogId.match(/cherry_tree|sunflower|maple_tree|snowman/) && !c.locked,
      ),
    ).toHaveLength(1);
    expect(first.catalog.find((c) => c.catalogId === 'lantern')?.locked).toBe(true);
    expect(((await (await call('c_isl_get', '/island')).json()) as IslandStateRes).visitDays).toBe(
      1,
    );
    clock = new Date(START.getTime() + DAY);
    expect(((await (await call('c_isl_get', '/island')).json()) as IslandStateRes).visitDays).toBe(
      2,
    );
  });

  it('validates the self figure, the catalog and locked items', async () => {
    expect((await call('c_isl_val', '/island', 'PUT', { items, selfFigureId: 'x' })).status).toBe(
      400,
    );
    expect(
      (
        await call('c_isl_val', '/island', 'PUT', {
          items: [...items, item('z', 'dragon', 'animal', 0.1, 0.1)],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('c_isl_val', '/island', 'PUT', {
          items: [...items, item('l', 'lantern', 'furniture', 0.1, 0.1)],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('c_isl_val', '/island', 'PUT', {
          items: [item('me', 'bear', 'animal', 1.5, 0.5)],
        })
      ).status,
    ).toBe(400);
    expect((await call('c_isl_val', '/island', 'PUT', { items })).status).toBe(200);
  });

  it('overwrites current, snapshots with previousSceneId, encrypts, and publishes artwork.created', async () => {
    const { child, base: b } = await base('c_isl_put');
    const first = (await (
      await call('c_isl_put', '/island', 'PUT', { items, selfFigureId: 'me' })
    ).json()) as IslandPutRes;
    const moved = [
      item('me', 'rabbit_small', 'animal', 0.1, 0.1),
      item('t', 'tree', 'plant', 0.5, 0.5),
    ];
    const res = await call('c_isl_put', '/island', 'PUT', {
      items: moved,
      narrative: { mode: 'typed', text: SENTINEL },
    });
    expect(res.status).toBe(200);
    const second = (await res.json()) as IslandPutRes;
    expect(second).toEqual({ sceneId: second.sceneId });

    const scene = (await db.doc(`${b}/islandScenes/${second.sceneId}`).get()).data()!;
    expect(scene['previousSceneId']).toBe(first.sceneId);
    expect(scene).not.toHaveProperty('selfFigureId');
    expect(Buffer.from(scene['sceneGraphEnc']).toString('utf8')).not.toContain('tree');
    expect(
      sessions.decryptForChild(
        child,
        Buffer.from(scene['narrativeEnc']),
        fieldAad(`${b}/islandScenes`, 'narrativeEnc'),
      ),
    ).toBe(SENTINEL);

    const current = (await db.doc(`${b}/island/current`).get()).data()!;
    expect(Object.keys(current).sort()).toEqual([
      'decorations',
      'goodThingCount',
      'lastVisitDate',
      'sceneGraphEnc',
      'season',
      'unlockedItems',
      'updatedAt',
      'visitDays',
    ]);
    expect(current['visitDays']).toBe(1);
    const state = (await (await call('c_isl_put', '/island')).json()) as IslandStateRes;
    expect(state.items).toEqual(moved);
    expect(state.selfFigureId).toBeUndefined();
    expect(published.map((p) => p.topic)).toEqual(['artwork.created', 'artwork.created']);
    expect(published[1]!.payload).toEqual({
      childId: 'c_isl_put',
      artworkId: second.sceneId,
      type: 'island',
    });
    expect(logLines.join('\n')).not.toContain(SENTINEL);
  });

  it('answers with the crisis payload and publishes no artwork.created when the narrative hits', async () => {
    const res = await call('c_isl_crisis', '/island', 'PUT', {
      items,
      selfFigureId: 'me',
      narrative: { mode: 'voice_transcript', text: '死にたい' },
    });
    const body = (await res.json()) as IslandPutRes;
    expect(body.crisis?.crisisId).toBeTruthy();
    expect(published.map((p) => p.topic)).toEqual(['crisis.detected']);
    const { base: b } = await base('c_isl_crisis');
    const crisis = (await db.doc(`${b}/crisisEvents/${body.crisis!.crisisId}`).get()).data()!;
    expect(crisis).toMatchObject({
      triggerType: 'island',
      sourceRef: `${b}/islandScenes/${body.sceneId}`,
    });
    expect(JSON.stringify(crisis)).not.toContain('死にたい');
  });

  it('keeps the legacy POST /island-scenes working through the new logic', async () => {
    const res = await call('c_isl_legacy', '/island-scenes', 'POST', { selfFigureId: 'me', items });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sceneId: string; petPrompt: string };
    expect(body.petPrompt).toBe('すてきな島だね！また遊びに行こうね。');
    const { base: b } = await base('c_isl_legacy');
    expect((await db.doc(`${b}/island/current`).get()).get('selfFigureId')).toBe('me');
    expect((await db.doc(`${b}/islandScenes/${body.sceneId}`).get()).exists).toBe(true);
    expect((await call('c_isl_legacy', '/island-scenes', 'POST', { items: [] })).status).toBe(400);
  });
});

describe('pet requests', () => {
  it('lists offered requests with prompt text from the kb and hides expired ones', async () => {
    const ref = await offer('c_req_list', 'pet_worry', 'pw_high_001', 'lantern');
    await offer('c_req_list', 'drawing', 'dr_food_low', 'table_round');
    const { base: b } = await base('c_req_list');
    await db.collection(`${b}/petRequests`).add({
      type: 'drawing',
      promptId: 'dr_weekend_low',
      rewardItemId: 'lantern',
      status: 'offered',
      offeredAt: clock,
      expiresAt: new Date(clock.getTime() - 1),
    });
    const body = (await (await call('c_req_list', '/pet-requests')).json()) as PetRequestsRes;
    expect(body.items.map((i) => i.promptId).sort()).toEqual(['dr_food_low', 'pw_high_001']);
    const worry = body.items.find((i) => i.requestId === ref.id)!;
    expect(worry).toMatchObject({
      type: 'pet_worry',
      rewardItemId: 'lantern',
      promptText: expect.stringContaining('班決め'),
    });
    expect(worry.options?.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(JSON.stringify(body)).not.toMatch(/tell_adult|kind/);
  });

  it('completes a drawing request: own saved drawing only, decoration and reward, idempotent', async () => {
    const ref = await offer('c_req_draw', 'drawing', 'dr_food_low', 'table_round');
    const art = await savedDrawing('c_req_draw');
    const other = await savedDrawing('c_req_draw_other');
    const path = `/pet-requests/${ref.id}/complete`;
    expect((await call('c_req_draw', path, 'POST', { type: 'story' })).status).toBe(400);
    expect(
      (await call('c_req_draw', path, 'POST', { type: 'drawing', artworkId: other.id })).status,
    ).toBe(400);
    const res = await call('c_req_draw', path, 'POST', { type: 'drawing', artworkId: art.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PetRequestCompleteRes;
    expect(body).toEqual({
      rewardItemId: 'table_round',
      petReply: '描いてくれてありがとう！おうちに飾ったよ。',
    });
    expect((await ref.get()).data()).toMatchObject({ status: 'completed', resultRef: art.id });
    expect((await art.get()).get('requestId')).toBe(ref.id);
    const state = (await (await call('c_req_draw', '/island')).json()) as IslandStateRes;
    expect(state.unlockedItems).toEqual(['table_round']);
    expect(state.decorations).toEqual([
      { artworkId: art.id, thumbnailUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    ]);
    expect(state.catalog.find((c) => c.catalogId === 'table_round')?.locked).toBe(false);
    expect(
      (
        await call('c_req_draw', '/island', 'PUT', {
          items: [item('f', 'table_round', 'furniture', 0.2, 0.2)],
        })
      ).status,
    ).toBe(200);
    const again = (await (
      await call('c_req_draw', path, 'POST', { type: 'drawing', artworkId: art.id })
    ).json()) as PetRequestCompleteRes;
    expect(again).toEqual(body);
    expect(
      ((await (await call('c_req_draw', '/island')).json()) as IslandStateRes).unlockedItems,
    ).toEqual(['table_round']);
    const home = (await (await call('c_req_draw', '/home')).json()) as ChildHomeRes;
    expect(home.petRequests).toEqual([]);
    expect(home.games).toEqual([]);
    expect(home.island).toMatchObject({ decorationCount: 1, stage: 1, season });
  });

  it('completes a story with a fixed ending option and publishes artwork.created for signal-worker', async () => {
    const ref = await offer('c_req_story', 'story', 'sp_low_002', 'table_round');
    const path = `/pet-requests/${ref.id}/complete`;
    expect((await call('c_req_story', path, 'POST', { type: 'story' })).status).toBe(400);
    expect(
      (
        await call('c_req_story', path, 'POST', {
          type: 'story',
          ending: { mode: 'option', text: 'zz' },
        })
      ).status,
    ).toBe(400);
    const res = await call('c_req_story', path, 'POST', {
      type: 'story',
      ending: { mode: 'option', text: 'c' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PetRequestCompleteRes).petReply).toBe(
      'お話の続きを聞かせてくれてありがとう！',
    );
    const { base: b } = await base('c_req_story');
    const artworkId = (await ref.get()).get('resultRef') as string;
    const art = (await db.doc(`${b}/artworks/${artworkId}`).get()).data()!;
    expect(art).toMatchObject({
      type: 'story',
      requestId: ref.id,
      promptId: 'sp_low_002',
      features: { storyOutcome: 'negative' },
      featureStatus: 'done',
      sharedWithGuardian: false,
    });
    expect(art).not.toHaveProperty('narrativeEnc');
    expect(published).toEqual([
      { topic: 'artwork.created', payload: { childId: 'c_req_story', artworkId, type: 'story' } },
    ]);
  });

  it('runs a typed story ending through crisis detection and stores it encrypted', async () => {
    const ref = await offer('c_req_story_text', 'story', 'sp_low_002', 'bench');
    const path = `/pet-requests/${ref.id}/complete`;
    const ok = await call('c_req_story_text', path, 'POST', {
      type: 'story',
      ending: { mode: 'typed', text: SENTINEL },
    });
    expect(ok.status).toBe(200);
    const { child, base: b } = await base('c_req_story_text');
    const artworkId = (await ref.get()).get('resultRef') as string;
    const art = (await db.doc(`${b}/artworks/${artworkId}`).get()).data()!;
    expect(art['featureStatus']).toBe('pending');
    expect(
      sessions.decryptForChild(
        child,
        Buffer.from(art['narrativeEnc']),
        fieldAad(`${b}/artworks`, 'narrativeEnc'),
      ),
    ).toBe(SENTINEL);
    expect(published.map((p) => p.topic)).toEqual(['artwork.created']);
    expect(logLines.join('\n')).not.toContain(SENTINEL);

    published.length = 0;
    const ref2 = await offer('c_req_story_text', 'story', 'sp_low_001', 'bench');
    const hit = (await (
      await call('c_req_story_text', `/pet-requests/${ref2.id}/complete`, 'POST', {
        type: 'story',
        ending: { mode: 'voice_transcript', text: '死にたい' },
      })
    ).json()) as PetRequestCompleteRes;
    expect(hit.crisis?.crisisId).toBeTruthy();
    expect(hit.rewardItemId).toBe('bench');
    expect(published.map((p) => p.topic)).toEqual(['crisis.detected']);
    const artwork2 = (await ref2.get()).get('resultRef') as string;
    expect((await db.doc(`${b}/artworks/${artwork2}`).get()).get('featureStatus')).toBe('skipped');
    const crisis = (await db.doc(`${b}/crisisEvents/${hit.crisis!.crisisId}`).get()).data()!;
    expect(crisis).toMatchObject({
      triggerType: 'artwork',
      sourceRef: `${b}/artworks/${artwork2}`,
    });
  });

  it('records the chosen worry option and opens a consultation for tell_adult', async () => {
    const talk = await offer('c_req_worry', 'pet_worry', 'pw_low_001', 'table_round');
    const path = (id: string) => `/pet-requests/${id}/complete`;
    expect(
      (await call('c_req_worry', path(talk.id), 'POST', { type: 'pet_worry', optionId: 'zz' }))
        .status,
    ).toBe(400);
    const first = (await (
      await call('c_req_worry', path(talk.id), 'POST', { type: 'pet_worry', optionId: 'b' })
    ).json()) as PetRequestCompleteRes;
    expect(first.petReply).toBe('そうか、それを やってみるね。きいてくれて ありがとう。');
    expect((await talk.get()).get('resultRef')).toBe('b');
    const { base: b } = await base('c_req_worry');
    expect((await db.collection(`${b}/consultations`).get()).size).toBe(0);

    const adult = await offer('c_req_worry', 'pet_worry', 'pw_low_001', 'lantern');
    const second = (await (
      await call('c_req_worry', path(adult.id), 'POST', { type: 'pet_worry', optionId: 'a' })
    ).json()) as PetRequestCompleteRes;
    expect(second.petReply).toBe('大人に話すのもいいね。いっしょに考えよう。');
    const consultation = (await db.doc(`${b}/consultations/req-${adult.id}`).get()).data()!;
    expect(consultation).toMatchObject({ level: 'l2', source: 'child', offerCount: 1 });
    const home = (await (await call('c_req_worry', '/home')).json()) as ChildHomeRes;
    expect(home.pendingConsultation).toEqual({ consultationId: `req-${adult.id}` });
    expect(
      ((await (await call('c_req_worry', '/island')).json()) as IslandStateRes).unlockedItems,
    ).toEqual(['table_round', 'lantern']);
  });

  it('declines, and refuses to complete declined, expired or unknown requests', async () => {
    const ref = await offer('c_req_decl', 'drawing', 'dr_weekend_low', 'lantern');
    const res = await call('c_req_decl', `/pet-requests/${ref.id}/decline`, 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect((await ref.get()).get('status')).toBe('declined');
    expect((await call('c_req_decl', `/pet-requests/${ref.id}/decline`, 'POST')).status).toBe(200);
    const art = await savedDrawing('c_req_decl');
    expect(
      (
        await call('c_req_decl', `/pet-requests/${ref.id}/complete`, 'POST', {
          type: 'drawing',
          artworkId: art.id,
        })
      ).status,
    ).toBe(404);
    expect((await call('c_req_decl', '/pet-requests/nope/decline', 'POST')).status).toBe(404);
    clock = new Date(START.getTime() + 17 * DAY);
    const old = await offer('c_req_decl', 'drawing', 'dr_weekend_low', 'lantern');
    clock = new Date(START.getTime() + 48 * DAY);
    expect(
      (
        await call('c_req_decl', `/pet-requests/${old.id}/complete`, 'POST', {
          type: 'drawing',
          artworkId: art.id,
        })
      ).status,
    ).toBe(404);
    expect(
      ((await (await call('c_req_decl', '/island')).json()) as IslandStateRes).unlockedItems,
    ).toEqual([]);
  });
});

describe('POST /v1/child/rituals', () => {
  it('records booleans only, counts good things once per day, and rejects far dates', async () => {
    const { base: b } = await base('c_rit');
    const today = TODAY;
    expect(
      (await call('c_rit', '/rituals', 'POST', { kind: 'nap', localDate: today })).status,
    ).toBe(400);
    expect(
      (
        await call('c_rit', '/rituals', 'POST', {
          kind: 'watered',
          localDate: jstDate(new Date(START.getTime() - 32 * DAY)),
        })
      ).status,
    ).toBe(400);
    const watered = (await (
      await call('c_rit', '/rituals', 'POST', { kind: 'watered', localDate: today })
    ).json()) as RitualRes;
    expect(watered).toEqual({
      rituals: { morningMood: false, okaeri: false, goodThing: false, watered: true },
      goodThingCount: 0,
    });
    const good = (await (
      await call('c_rit', '/rituals', 'POST', { kind: 'good_thing', localDate: today })
    ).json()) as RitualRes;
    expect(good).toEqual({
      rituals: { morningMood: false, okaeri: false, goodThing: true, watered: true },
      goodThingCount: 1,
    });
    expect(
      (await (
        await call('c_rit', '/rituals', 'POST', { kind: 'good_thing', localDate: today })
      ).json()) as RitualRes,
    ).toEqual(good);
    const slack = islandConfig.ritualDateSlackDays;
    expect(slack).toBeGreaterThanOrEqual(1);
    const yesterday = (await (
      await call('c_rit', '/rituals', 'POST', { kind: 'good_thing', localDate: YESTERDAY })
    ).json()) as RitualRes;
    expect(yesterday.goodThingCount).toBe(2);
    const doc = (await db.doc(`${b}/dailyRituals/${today}`).get()).data()!;
    expect(Object.keys(doc).sort()).toEqual([
      'goodThing',
      'localDate',
      'morningMood',
      'okaeri',
      'updatedAt',
      'watered',
    ]);

    await call('c_rit', '/mood', 'POST', { weather: 'sunny' });
    await call('c_rit', '/home-checkins', 'POST', { atHome: true, method: 'manual' });
    const home = (await (await call('c_rit', '/home')).json()) as ChildHomeRes;
    expect(home.rituals).toEqual({
      morningMood: true,
      okaeri: true,
      goodThing: true,
      watered: true,
    });
    expect(home.island).toEqual({ visitDays: 1, stage: 1, season, decorationCount: 0 });
    const state = (await (await call('c_rit', '/island')).json()) as IslandStateRes;
    expect(state.goodThingCount).toBe(2);
  });
});
