import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  ScriptedLlm,
  type Script,
} from '@ijime/agent-core';
import { fieldAad } from '@ijime/crypto';
import { FsKbSource, Kb, type SignalDefinition } from '@ijime/kb-loader';
import { encodePushEnvelope, Logger, MemoryPublisher } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { ARTWORK_FEATURES_PATH } from './artworks.js';
import { indexDefs } from './rules.js';
import { loadSignalDefs, type SignalDoc } from './store.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SENTINEL = 'SENTINEL_え の せつめい';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

let db: Firestore;
let kb: Kb;
let directory: DevChildDirectory;
let sessions: FirestoreSessionService;
let defs: Map<string, SignalDefinition>;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  kb = await Kb.load(new FsKbSource(KB_DIR));
  directory = new DevChildDirectory(db);
  sessions = new FirestoreSessionService(db, directory);
  defs = indexDefs(await loadSignalDefs(kb));
});
afterAll(() => db.terminate());

function setup(artworkScript: Script) {
  const lines: string[] = [];
  const logger = new Logger('signal-worker', (l) => lines.push(l));
  const publisher = new MemoryPublisher();
  const artworkLlm = new ScriptedLlm(artworkScript, { model: 'scripted-artwork' });
  const flash = new ScriptedLlm(() => ({ text: '{}' }), { model: 'scripted-extract' });
  const app = createApp(
    async () => ({
      db,
      kb,
      sessions,
      directory,
      publisher,
      model: flash,
      artworkModel: artworkLlm,
      logger,
      now: () => new Date(),
    }),
    logger,
  );
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  const push = (path: string, payload: unknown) => post(path, encodePushEnvelope(payload));
  return { lines, publisher, artworkLlm, flash, post, push };
}

const base = (familyId: string, childId: string) => `families/${familyId}/children/${childId}`;

async function signalsOf(familyId: string, childId: string): Promise<SignalDoc[]> {
  const snap = await db.collection(`${base(familyId, childId)}/signals`).get();
  return snap.docs.map((d) => d.data() as SignalDoc);
}

async function seedArtwork(childId: string, narrative?: string) {
  const child = await directory.lookup(childId);
  const collection = `${base(child.familyId, childId)}/artworks`;
  const ref = db.collection(collection).doc();
  await ref.set({
    type: 'story',
    ...(narrative
      ? {
          narrativeEnc: sessions.encryptForChild(
            child,
            narrative,
            fieldAad(collection, 'narrativeEnc'),
          ),
        }
      : {}),
    features: {},
    featureStatus: 'pending',
    sharedWithGuardian: false,
    createdAt: new Date('2026-10-01T07:00:00Z'),
  });
  return { child, ref };
}

const FEATURES = {
  selfPresent: true,
  selfSizeRatio: 0.08,
  othersCount: 3,
  nearestOtherDist: 0.7,
  isolated: true,
  storyOutcome: 'negative',
  explicitHarm: true,
  contextKind: 'self_report',
  evidence: [{ source: 'current', turnIndex: 0, quote: '昨日ぼくがたたかれた。' }],
};

describe('artwork features (internal call from api)', () => {
  it('extracts features from the image and narrative, writes D signals, and is idempotent', async () => {
    const { child, ref } = await seedArtwork('c_art1', `昨日ぼくがたたかれた。${SENTINEL}`);
    const t = setup(() => ({ text: JSON.stringify(FEATURES) }));
    const req = { familyId: child.familyId, childId: 'c_art1', artworkId: ref.id };
    const res = await t.post(ARTWORK_FEATURES_PATH, {
      ...req,
      image: { mimeType: 'image/png', data: PNG },
    });
    expect(res.status).toBe(204);

    const user = t.artworkLlm.requests[0]!.contents.find((c) => c.role === 'user')!;
    expect(user.parts?.[0]?.text).toContain(SENTINEL);
    expect(user.parts?.[1]).toEqual({ inlineData: { mimeType: 'image/png', data: PNG } });

    const doc = (await ref.get()).data()!;
    expect(doc['featureStatus']).toBe('done');
    expect(doc['features']).toEqual({ ...FEATURES, evidence: undefined, evidenceMatched: true });
    expect(doc['features']).not.toHaveProperty('evidence');
    expect(doc['featureModel']).toBe('scripted-artwork/prompts/artwork_feature.md@0.1.0');

    const signals = await signalsOf(child.familyId, 'c_art1');
    expect(signals.map((s) => s.signalDefId).sort()).toEqual([
      'D-HARM-001',
      'D-ISO-001',
      'D-NEAR-001',
      'D-SELF-001',
      'D-STORY-001',
    ]);
    expect(signals.every((s) => s.sourceRef === ref.path && s.localDate === '2026-10-01')).toBe(
      true,
    );
    expect(signals.find((s) => s.explicit)?.signalDefId).toBe('D-HARM-001');
    expect(t.publisher.of('signal.extracted')).toEqual([
      { childId: 'c_art1', domains: ['d'], explicit: true },
    ]);

    // 再度の呼び出し：完了済みの作品は重ねて抽出しない
    await t.post(ARTWORK_FEATURES_PATH, { ...req, image: { mimeType: 'image/png', data: PNG } });
    expect(t.artworkLlm.requests).toHaveLength(1);
    expect(await signalsOf(child.familyId, 'c_art1')).toHaveLength(5);
    const all = [...t.lines, JSON.stringify(signals), JSON.stringify(t.publisher.published)];
    expect(all.join('\n')).not.toContain(SENTINEL);
    expect(JSON.stringify(doc['features'])).not.toContain('昨日ぼくがたたかれた');
  });

  it.each([
    ['image-only', undefined, { contextKind: 'self_report', evidence: FEATURES.evidence }],
    [
      'fiction',
      '昨日ぼくがたたかれたというお話。',
      {
        contextKind: 'fiction',
        evidence: [{ source: 'current', turnIndex: 0, quote: '昨日ぼくがたたかれたというお話。' }],
      },
    ],
    [
      'quotation',
      '友達が「たたかれた」と言った。',
      {
        contextKind: 'quotation',
        evidence: [{ source: 'current', turnIndex: 0, quote: '友達が「たたかれた」と言った。' }],
      },
    ],
    ['legacy', SENTINEL, {}],
    ['ungrounded', SENTINEL, { contextKind: 'self_report', evidence: FEATURES.evidence }],
  ] as const)(
    'keeps longitudinal D features but never D-HARM for %s',
    async (id, narrative, extra) => {
      const childId = `c_art_evidence_${id}`;
      const { child, ref } = await seedArtwork(childId, narrative);
      const legacy = {
        selfPresent: FEATURES.selfPresent,
        selfSizeRatio: FEATURES.selfSizeRatio,
        othersCount: FEATURES.othersCount,
        nearestOtherDist: FEATURES.nearestOtherDist,
        isolated: FEATURES.isolated,
        storyOutcome: FEATURES.storyOutcome,
        explicitHarm: FEATURES.explicitHarm,
      };
      const t = setup(() => ({ text: JSON.stringify({ ...legacy, ...extra }) }));
      expect(
        (
          await t.post(ARTWORK_FEATURES_PATH, {
            familyId: child.familyId,
            childId,
            artworkId: ref.id,
            image: { mimeType: 'image/png', data: PNG },
          })
        ).status,
      ).toBe(204);
      const docs = await signalsOf(child.familyId, childId);
      expect(docs).toHaveLength(4);
      expect(docs.every((s) => !s.explicit && s.signalDefId !== 'D-HARM-001')).toBe(true);
      const saved = (await ref.get()).data()!;
      expect(saved['features']).toMatchObject({ explicitHarm: false, selfSizeRatio: 0.08 });
      expect(saved['features']).not.toHaveProperty('evidence');
      expect(t.publisher.of('signal.extracted')).toEqual([
        { childId, domains: ['d'], explicit: false },
      ]);
      expect(
        JSON.stringify([saved['features'], docs, t.lines, t.publisher.published]),
      ).not.toContain(SENTINEL);
    },
  );

  it('gives up after a retry when the model keeps failing: no signals, status skipped', async () => {
    const { child, ref } = await seedArtwork('c_art2');
    const t = setup(() => ({ text: 'not json' }));
    const res = await t.post(ARTWORK_FEATURES_PATH, {
      familyId: child.familyId,
      childId: 'c_art2',
      artworkId: ref.id,
      image: { mimeType: 'image/png', data: PNG },
    });
    expect(res.status).toBe(204);
    expect(t.artworkLlm.requests).toHaveLength(2);
    expect((await ref.get()).data()!['featureStatus']).toBe('skipped');
    expect(await signalsOf(child.familyId, 'c_art2')).toEqual([]);
    expect(t.publisher.published).toEqual([]);
  });

  it('rejects a non-PNG payload without calling the model', async () => {
    const { child, ref } = await seedArtwork('c_art3');
    const t = setup(() => ({ text: JSON.stringify(FEATURES) }));
    const res = await t.post(ARTWORK_FEATURES_PATH, {
      familyId: child.familyId,
      childId: 'c_art3',
      artworkId: ref.id,
      image: { mimeType: 'image/jpeg', data: PNG },
    });
    expect(res.status).toBe(204);
    expect(t.artworkLlm.requests).toHaveLength(0);
  });
});

const DEFAULT_ITEMS = [
  {
    id: 'me',
    catalogId: 'rabbit_small',
    category: 'animal',
    x: 0.1,
    y: 0.1,
    rotation: 0,
    layer: 0,
  },
  { id: 'b', catalogId: 'bear', category: 'animal', x: 0.8, y: 0.8, rotation: 0, layer: 1 },
  { id: 't', catalogId: 'tree', category: 'nature', x: 0.2, y: 0.1, rotation: 0, layer: 2 },
];

async function seedIsland(
  childId: string,
  narrative?: string,
  options: {
    items?: typeof DEFAULT_ITEMS;
    selfFigureId?: string | null;
    previousSceneId?: string;
  } = {},
) {
  const child = await directory.lookup(childId);
  const collection = `${base(child.familyId, childId)}/islandScenes`;
  const ref = db.collection(collection).doc();
  const items = options.items ?? DEFAULT_ITEMS;
  const selfFigureId = options.selfFigureId === undefined ? 'me' : options.selfFigureId;
  await ref.set({
    sceneGraphEnc: sessions.encryptForChild(
      child,
      JSON.stringify({ items }),
      fieldAad(collection, 'sceneGraphEnc'),
    ),
    ...(selfFigureId ? { selfFigureId } : {}),
    ...(options.previousSceneId ? { previousSceneId: options.previousSceneId } : {}),
    ...(narrative
      ? {
          narrativeEnc: sessions.encryptForChild(
            child,
            narrative,
            fieldAad(collection, 'narrativeEnc'),
          ),
        }
      : {}),
    features: {},
    createdAt: new Date('2026-10-01T07:00:00Z'),
  });
  return { child, ref };
}

describe('artwork.created (island)', () => {
  it('compares with the previous snapshot and tolerates a missing self figure', async () => {
    const first = await seedIsland('c_isl_diff');
    const t = setup(() => ({ text: '{}' }));
    expect(
      (
        await t.push('/internal/events/artwork-created', {
          childId: 'c_isl_diff',
          artworkId: first.ref.id,
          type: 'island',
        })
      ).status,
    ).toBe(204);
    const second = await seedIsland('c_isl_diff', undefined, {
      selfFigureId: null,
      previousSceneId: first.ref.id,
      items: [
        { ...DEFAULT_ITEMS[0]!, x: 0.5, y: 0.5 },
        DEFAULT_ITEMS[2]!,
        {
          id: 'h',
          catalogId: 'house',
          category: 'building',
          x: 0.9,
          y: 0.1,
          rotation: 0,
          layer: 0,
        },
      ],
    });
    expect(
      (
        await t.push('/internal/events/artwork-created', {
          childId: 'c_isl_diff',
          artworkId: second.ref.id,
          type: 'island',
        })
      ).status,
    ).toBe(204);
    expect((await second.ref.get()).data()!['features']).toEqual({
      selfToNearestDist: null,
      selfToCenterDist: null,
      enclosed: null,
      isolated: null,
      categoryCounts: { animal: 1, nature: 1, building: 1 },
      addedCount: 1,
      removedCount: 1,
      movedCount: 1,
    });
    const signals = await signalsOf(first.child.familyId, 'c_isl_diff');
    expect(signals.every((s) => s.sourceRef === first.ref.path)).toBe(true);
    expect(t.artworkLlm.requests).toHaveLength(0);
  });

  it('skips a scene whose previous snapshot is gone, counting everything as added', async () => {
    const { child, ref } = await seedIsland('c_isl_prevgone', undefined, {
      previousSceneId: 'gone',
    });
    const t = setup(() => ({ text: '{}' }));
    await t.push('/internal/events/artwork-created', {
      childId: 'c_isl_prevgone',
      artworkId: ref.id,
      type: 'island',
    });
    expect((await ref.get()).data()!['features']).toMatchObject({
      addedCount: 3,
      removedCount: 0,
      movedCount: 0,
    });
    expect(await signalsOf(child.familyId, 'c_isl_prevgone')).toHaveLength(4);
  });

  it('computes geometry by rule and the ending by model', async () => {
    const { child, ref } = await seedIsland('c_isl1', SENTINEL);
    const t = setup(() => ({ text: '{"storyOutcome":"negative","explicitHarm":false}' }));
    const ev = { childId: 'c_isl1', artworkId: ref.id, type: 'island' };
    expect((await t.push('/internal/events/artwork-created', ev)).status).toBe(204);

    expect(t.artworkLlm.requests[0]!.contents.at(-1)?.parts?.[0]?.text).toBe(SENTINEL);
    const features = (await ref.get()).data()!['features'];
    expect(features).toEqual({
      selfToNearestDist: 0.99,
      selfToCenterDist: 0.566,
      enclosed: false,
      isolated: false,
      categoryCounts: { animal: 2, nature: 1 },
      addedCount: 3,
      removedCount: 0,
      movedCount: 0,
      storyOutcome: 'negative',
    });
    const signals = await signalsOf(child.familyId, 'c_isl1');
    const byId = Object.fromEntries(signals.map((s) => [s.signalDefId, s]));
    expect(Object.keys(byId).sort()).toEqual([
      'D-ENCL-001',
      'D-ISLCTR-001',
      'D-ISLNEAR-001',
      'D-ISO-001',
      'D-STORY-001',
    ]);
    expect(byId['D-ISO-001']!.extractedBy).toBe('rule');
    expect(signals.every((s) => s.scoring === defs.get(s.signalDefId)!.scoring)).toBe(true);
    expect(byId['D-STORY-001']!.extractedBy).toBe(
      'scripted-artwork/prompts/island_narrative.md@0.1.0',
    );
    expect(t.publisher.of('signal.extracted')).toEqual([
      { childId: 'c_isl1', domains: ['d'], explicit: false },
    ]);
    expect(t.lines.join('\n')).not.toContain(SENTINEL);
  });

  it.each(['self_report', 'fiction', 'quotation', 'uncertain'] as const)(
    'replays island narrative %s without treating geometry as evidence',
    async (contextKind) => {
      const childId = `c_isl_evidence_${contextKind}`;
      const narrative = `昨日ぼくがたたかれた。${SENTINEL}`;
      const { child, ref } = await seedIsland(childId, narrative);
      const t = setup(() => ({
        text: JSON.stringify({
          storyOutcome: 'negative',
          explicitHarm: true,
          contextKind,
          evidence: [{ source: 'current', turnIndex: 0, quote: narrative }],
        }),
      }));
      const ev = { childId, artworkId: ref.id, type: 'island' };
      expect((await t.push('/internal/events/artwork-created', ev)).status).toBe(204);
      expect((await t.push('/internal/events/artwork-created', ev)).status).toBe(204);
      const docs = await signalsOf(child.familyId, childId);
      expect(docs).toHaveLength(contextKind === 'self_report' ? 6 : 5);
      expect(docs.some((s) => s.explicit)).toBe(contextKind === 'self_report');
      expect(
        t.publisher
          .of('signal.extracted')
          .every((e) => e.explicit === (contextKind === 'self_report')),
      ).toBe(true);
      expect(
        JSON.stringify([
          docs,
          (await ref.get()).data()!['features'],
          t.lines,
          t.publisher.published,
        ]),
      ).not.toContain(SENTINEL);
    },
  );

  it('keeps the geometry when the narrative model fails, and skips other artwork types', async () => {
    const { child, ref } = await seedIsland('c_isl2', 'おわり');
    const t = setup(() => ({ text: 'oops' }));
    await t.push('/internal/events/artwork-created', {
      childId: 'c_isl2',
      artworkId: ref.id,
      type: 'island',
    });
    const signals = await signalsOf(child.familyId, 'c_isl2');
    expect(signals.map((s) => s.signalDefId).sort()).toEqual([
      'D-ENCL-001',
      'D-ISLCTR-001',
      'D-ISLNEAR-001',
      'D-ISO-001',
    ]);
    expect((await ref.get()).data()!['features']).not.toHaveProperty('storyOutcome');

    const before = t.artworkLlm.requests.length;
    const res = await t.push('/internal/events/artwork-created', {
      childId: 'c_isl2',
      artworkId: ref.id,
      type: 'story',
    });
    expect(res.status).toBe(204);
    expect(t.artworkLlm.requests).toHaveLength(before);
  });
});

async function seedStory(childId: string, data: Record<string, unknown>, narrative?: string) {
  const child = await directory.lookup(childId);
  const collection = `${base(child.familyId, childId)}/artworks`;
  const ref = db.collection(collection).doc();
  await ref.set({
    type: 'story',
    promptId: 'sp_001',
    features: {},
    featureModel: '',
    featureStatus: 'pending',
    sharedWithGuardian: false,
    createdAt: new Date('2026-10-01T07:00:00Z'),
    ...(narrative
      ? {
          narrativeEnc: sessions.encryptForChild(
            child,
            narrative,
            fieldAad(collection, 'narrativeEnc'),
          ),
        }
      : {}),
    ...data,
  });
  return { child, ref };
}

describe('artwork.created (story ending)', () => {
  it('scores a fixed ending option by rule without calling the model', async () => {
    const { child, ref } = await seedStory('c_story_opt', {
      features: { storyOutcome: 'negative' },
      storyOutcomeSource: 'option',
      featureStatus: 'done',
    });
    const t = setup(() => ({ text: 'never' }));
    const ev = { childId: 'c_story_opt', artworkId: ref.id, type: 'story' };
    expect((await t.push('/internal/events/artwork-created', ev)).status).toBe(204);
    expect((await t.push('/internal/events/artwork-created', ev)).status).toBe(204);
    const signals = await signalsOf(child.familyId, 'c_story_opt');
    expect(signals.map((s) => [s.signalDefId, s.extractedBy, s.scoring])).toEqual([
      ['D-STORY-001', 'rule', 'score'],
    ]);
    expect(t.artworkLlm.requests).toHaveLength(0);
    expect(t.publisher.of('signal.extracted')).toEqual([
      { childId: 'c_story_opt', domains: ['d'], explicit: false },
      { childId: 'c_story_opt', domains: ['d'], explicit: false },
    ]);
  });

  it('extracts the outcome of a typed ending with the model and keeps the text out of logs', async () => {
    const { child, ref } = await seedStory('c_story_text', {}, SENTINEL);
    const t = setup(() => ({ text: '{"storyOutcome":"compensated","explicitHarm":false}' }));
    expect(
      (
        await t.push('/internal/events/artwork-created', {
          childId: 'c_story_text',
          artworkId: ref.id,
          type: 'story',
        })
      ).status,
    ).toBe(204);
    expect(t.artworkLlm.requests[0]!.contents.at(-1)?.parts?.[0]?.text).toBe(SENTINEL);
    const doc = (await ref.get()).data()!;
    expect(doc['features']).toEqual({ storyOutcome: 'compensated' });
    expect(doc['featureStatus']).toBe('done');
    expect(doc['featureModel']).toBe('scripted-artwork/prompts/island_narrative.md@0.1.0');
    const signals = await signalsOf(child.familyId, 'c_story_text');
    expect(signals.map((s) => [s.signalDefId, s.metric?.value])).toEqual([['D-STORY-001', 0]]);
    expect(t.lines.join('\n')).not.toContain(SENTINEL);
  });

  it('marks the artwork skipped when the model fails, and ignores crisis-skipped artworks', async () => {
    const { child, ref } = await seedStory('c_story_fail', {}, 'おわり');
    const t = setup(() => ({ text: 'oops' }));
    await t.push('/internal/events/artwork-created', {
      childId: 'c_story_fail',
      artworkId: ref.id,
      type: 'story',
    });
    expect((await ref.get()).get('featureStatus')).toBe('skipped');
    expect(await signalsOf(child.familyId, 'c_story_fail')).toEqual([]);
    const skipped = await seedStory('c_story_fail', { featureStatus: 'skipped' }, 'おわり');
    const before = t.artworkLlm.requests.length;
    expect(
      (
        await t.push('/internal/events/artwork-created', {
          childId: 'c_story_fail',
          artworkId: skipped.ref.id,
          type: 'story',
        })
      ).status,
    ).toBe(204);
    expect(t.artworkLlm.requests).toHaveLength(before);
  });
});

describe('checkin.created', () => {
  async function seedCheckins(childId: string) {
    const child = await directory.lookup(childId);
    const b = base(child.familyId, childId);
    const mood = await db.collection(`${b}/moodCheckins`).add({
      weather: 'rainy',
      localDate: '2026-10-01',
      localHour: 16,
      createdAt: new Date('2026-10-01T07:00:00Z'),
    });
    const home = await db.collection(`${b}/homeCheckins`).add({
      atHome: true,
      method: 'manual',
      localDate: '2026-10-01',
      checkinAt: new Date('2026-10-01T07:40:00Z'),
    });
    const away = await db.collection(`${b}/homeCheckins`).add({
      atHome: false,
      method: 'manual',
      localDate: '2026-10-01',
      checkinAt: new Date('2026-10-01T07:50:00Z'),
    });
    return { child, mood, home, away };
  }

  it('writes the mood score and home arrival hour as rule signals', async () => {
    const { child, mood, home, away } = await seedCheckins('c_chk1');
    const t = setup(() => ({ text: '{}' }));
    const path = '/internal/events/checkin-created';
    await t.push(path, { childId: 'c_chk1', kind: 'mood', checkinId: mood.id });
    await t.push(path, { childId: 'c_chk1', kind: 'home', checkinId: home.id });
    await t.push(path, { childId: 'c_chk1', kind: 'home', checkinId: away.id });
    await t.push(path, { childId: 'c_chk1', kind: 'mood', checkinId: mood.id });

    const signals = await signalsOf(child.familyId, 'c_chk1');
    expect(signals.map((s) => [s.signalDefId, s.metric?.value]).sort()).toEqual([
      ['I-HOME-001', 16],
      ['M-MOOD-001', 1],
    ]);
    expect(t.publisher.of('signal.extracted')).toEqual([
      { childId: 'c_chk1', domains: ['m'], explicit: false },
      { childId: 'c_chk1', domains: ['i'], explicit: false },
      { childId: 'c_chk1', domains: ['m'], explicit: false },
    ]);
    expect(t.artworkLlm.requests).toHaveLength(0);
    expect(t.flash.requests).toHaveLength(0);
  });

  it('writes no home signal when the child turned home check-in off', async () => {
    const { child, home } = await seedCheckins('c_chk2');
    await db.doc(base(child.familyId, 'c_chk2')).update({ 'dataSources.home_checkin': false });
    const t = setup(() => ({ text: '{}' }));
    const res = await t.push('/internal/events/checkin-created', {
      childId: 'c_chk2',
      kind: 'home',
      checkinId: home.id,
    });
    expect(res.status).toBe(204);
    expect(await signalsOf(child.familyId, 'c_chk2')).toEqual([]);
  });
});
