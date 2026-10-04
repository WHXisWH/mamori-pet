import type { Domain } from '@ijime/api-types';
import { fieldAad } from '@ijime/crypto';
import { islandGeometrySchema } from '@ijime/kb-loader';
import { SkipEvent, type EventPayload } from '@ijime/service-kit';
import { z } from 'zod';

import type { SignalWorkerDeps } from './deps.js';
import { matchEvidence } from './evidence.js';
import {
  artworkFeatureVersion,
  extractArtworkFeatures,
  extractIslandStory,
  ARTWORK_PROMPT,
  ISLAND_PROMPT,
} from './extract.js';
import {
  artworkSignals,
  indexDefs,
  islandDiff,
  islandGeometry,
  islandSignals,
  islandStorySignals,
  type IslandPlacement,
  type IslandStory,
  type SignalDraft,
  type StoryOutcome,
} from './rules.js';
import { childDocPath, loadSignalDefs, readChild, writeSignals } from './store.js';

export const ARTWORK_FEATURES_PATH = '/internal/artworks/features';

// api が提出リクエストの中で呼び出す（原画はメモリ上でだけ signal-worker に渡し、一時バケットには置かない）
export const artworkFeaturesSchema = z.strictObject({
  familyId: z.string().min(1).max(128),
  childId: z.string().min(1).max(128),
  artworkId: z.string().min(1).max(128),
  image: z.strictObject({
    mimeType: z.literal('image/png'),
    // 2 MB の PNG は base64 で約 2.8 MB になる
    data: z.string().min(1).max(3_000_000),
  }),
});
export type ArtworkFeaturesReq = z.infer<typeof artworkFeaturesSchema>;

type ArtworkDoc = {
  type: 'drawing' | 'self_portrait' | 'story';
  narrativeEnc?: Uint8Array;
  featureStatus?: 'pending' | 'done' | 'skipped';
  features?: { storyOutcome?: StoryOutcome };
  storyOutcomeSource?: string;
  createdAt: { toDate(): Date } | Date;
};

type IslandDoc = {
  sceneGraphEnc: Uint8Array;
  selfFigureId?: string;
  previousSceneId?: string;
  narrativeEnc?: Uint8Array;
  createdAt: { toDate(): Date } | Date;
};

const toDate = (d: { toDate(): Date } | Date) => (d instanceof Date ? d : d.toDate());

async function publishExtracted(
  deps: SignalWorkerDeps,
  childId: string,
  drafts: readonly SignalDraft[],
): Promise<boolean> {
  if (drafts.length === 0) return false;
  const domains = [...new Set(drafts.map((s) => s.domain))].sort() as Domain[];
  const explicit = drafts.some((s) => s.explicit);
  await deps.publisher.publish('signal.extracted', { childId, domains, explicit });
  return explicit;
}

export async function handleArtworkFeatures(
  deps: SignalWorkerDeps,
  req: ArtworkFeaturesReq,
): Promise<void> {
  const { db, kb, logger } = deps;
  const child = await readChild(db, req.familyId, req.childId);
  if (!child) throw new SkipEvent('child_not_found');
  const collection = `${childDocPath(req.familyId, req.childId)}/artworks`;
  const ref = db.doc(`${collection}/${req.artworkId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new SkipEvent('source_deleted');
  const art = snap.data() as ArtworkDoc;
  if (art.featureStatus === 'done') return;

  let narrative = '';
  if (art.narrativeEnc) {
    const record = await deps.directory.lookup(req.childId);
    if (!record) throw new SkipEvent('child_not_found');
    narrative = deps.sessions.decryptForChild(
      record,
      Buffer.from(art.narrativeEnc),
      fieldAad(collection, 'narrativeEnc'),
    );
  }

  const featureModel = artworkFeatureVersion(kb, ARTWORK_PROMPT, deps.artworkModel);
  // 作品種別 drawing の特徴プロンプトには self_portrait のものを使う
  const promptType = art.type === 'story' ? 'story' : 'self_portrait';
  const result = await extractArtworkFeatures({
    kb,
    model: deps.artworkModel,
    type: promptType,
    narrative,
    image: req.image,
  });
  if (!result.ok) {
    await ref.update({ featureStatus: 'skipped', featureModel });
    logger.warn('artwork.features_skipped', {
      artworkId: req.artworkId,
      reason: result.reason,
      attempts: result.attempts,
    });
    return;
  }

  const defs = indexDefs(await loadSignalDefs(kb));
  const drafts = artworkSignals(defs, promptType, result.value, narrative);
  await writeSignals(
    db,
    {
      familyId: req.familyId,
      childId: req.childId,
      sourceRef: ref.path,
      occurredAt: toDate(art.createdAt),
      kbVersion: kb.version,
      extractedBy: featureModel,
      now: deps.now(),
    },
    drafts,
  );
  const match = matchEvidence(result.value, { current: narrative });
  const features = {
    ...result.value,
    contextKind: match.contextKind,
    evidenceMatched: match.evidenceMatched,
    explicitHarm: result.value.explicitHarm && match.eligible,
  };
  delete features.evidence;
  await ref.update({ features, featureModel, featureStatus: 'done' });
  const explicit = await publishExtracted(deps, req.childId, drafts);
  logger.info('artwork.features_extracted', {
    artworkId: req.artworkId,
    signals: drafts.length,
    explicit,
  });
}

const placementSchema = z.array(
  z.object({ id: z.string(), category: z.string(), x: z.number(), y: z.number() }),
);

export async function handleArtworkCreated(
  deps: SignalWorkerDeps,
  ev: EventPayload<'artwork.created'>,
): Promise<void> {
  if (ev.type === 'island') return handleIslandCreated(deps, ev);
  if (ev.type === 'story') return handleStoryCreated(deps, ev);
  throw new SkipEvent('unsupported_artwork_type');
}

function decodePlacements(
  deps: SignalWorkerDeps,
  record: { dek: Buffer },
  collection: string,
  enc: Uint8Array | undefined,
): IslandPlacement[] | undefined {
  if (!enc) return undefined;
  const graph = JSON.parse(
    deps.sessions.decryptForChild(record, Buffer.from(enc), fieldAad(collection, 'sceneGraphEnc')),
  ) as { items?: unknown };
  const items = placementSchema.safeParse(graph.items);
  return items.success ? (items.data as IslandPlacement[]) : undefined;
}

export async function handleIslandCreated(
  deps: SignalWorkerDeps,
  ev: EventPayload<'artwork.created'>,
): Promise<void> {
  if (ev.type !== 'island') throw new SkipEvent('not_island');
  const { db, kb, logger } = deps;
  const record = await deps.directory.lookup(ev.childId);
  if (!record) throw new SkipEvent('child_not_found');
  const collection = `${childDocPath(record.familyId, ev.childId)}/islandScenes`;
  const ref = db.doc(`${collection}/${ev.artworkId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new SkipEvent('source_deleted');
  const scene = snap.data() as IslandDoc;

  const items = decodePlacements(deps, record, collection, scene.sceneGraphEnc);
  if (!items) throw new SkipEvent('invalid_scene');
  const rules = await kb.yaml('rules/island_geometry.yaml', islandGeometrySchema);
  const geometry = islandGeometry(items, scene.selfFigureId, rules);
  // 前回のスナップショットと比べて追加・削除・移動を求める。前回分が削除済みか解析できないときは現在の状態だけを記録する
  let previous: IslandPlacement[] = [];
  if (scene.previousSceneId) {
    const prev = (await db.doc(`${collection}/${scene.previousSceneId}`).get()).data() as
      IslandDoc | undefined;
    previous = decodePlacements(deps, record, collection, prev?.sceneGraphEnc) ?? [];
  }
  const diff = islandDiff(previous, items);

  // 語りの結末はモデルに任せる。失敗したら幾何特徴だけを記録する（docs/02-agent-architecture.md：作品特徴の失敗はリトライ後に諦める）
  let story: IslandStory | undefined;
  let narrative = '';
  if (scene.narrativeEnc) {
    narrative = deps.sessions.decryptForChild(
      record,
      Buffer.from(scene.narrativeEnc),
      fieldAad(collection, 'narrativeEnc'),
    );
    const result = await extractIslandStory({ kb, model: deps.artworkModel, narrative });
    if (result.ok) story = result.value;
    else
      logger.warn('island.story_skipped', {
        sceneId: ev.artworkId,
        reason: result.reason,
        attempts: result.attempts,
      });
  }

  const defs = indexDefs(await loadSignalDefs(kb));
  const geometryDrafts = islandSignals(defs, geometry);
  const storyDrafts = story ? islandStorySignals(defs, story, narrative) : [];
  const base = {
    familyId: record.familyId,
    childId: ev.childId,
    sourceRef: ref.path,
    occurredAt: toDate(scene.createdAt),
    kbVersion: kb.version,
    now: deps.now(),
  };
  await writeSignals(db, { ...base, extractedBy: 'rule' }, geometryDrafts);
  await writeSignals(
    db,
    { ...base, extractedBy: artworkFeatureVersion(kb, ISLAND_PROMPT, deps.artworkModel) },
    storyDrafts,
  );
  await ref.update({
    features: { ...geometry, ...diff, ...(story ? { storyOutcome: story.storyOutcome } : {}) },
  });
  const explicit = await publishExtracted(deps, ev.childId, [...geometryDrafts, ...storyDrafts]);
  logger.info('island.features_extracted', {
    sceneId: ev.artworkId,
    signals: geometryDrafts.length + storyDrafts.length,
    explicit,
  });
}

// おはなしリレーの結末：選択肢なら storyOutcome がそのまま決まる。子どもが語った結末はモデルに任せる（島の語りと同じプロンプト）
export async function handleStoryCreated(
  deps: SignalWorkerDeps,
  ev: EventPayload<'artwork.created'>,
): Promise<void> {
  if (ev.type !== 'story') throw new SkipEvent('not_story');
  const { db, kb, logger } = deps;
  const record = await deps.directory.lookup(ev.childId);
  if (!record) throw new SkipEvent('child_not_found');
  const collection = `${childDocPath(record.familyId, ev.childId)}/artworks`;
  const ref = db.doc(`${collection}/${ev.artworkId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new SkipEvent('source_deleted');
  const art = snap.data() as ArtworkDoc;
  if (art.type !== 'story' || art.featureStatus === 'skipped') throw new SkipEvent('not_story');

  let story: IslandStory | undefined;
  let narrative = '';
  let extractedBy = 'rule';
  if (art.storyOutcomeSource === 'option' && art.features?.storyOutcome) {
    story = { storyOutcome: art.features.storyOutcome, explicitHarm: false };
  } else if (art.narrativeEnc) {
    narrative = deps.sessions.decryptForChild(
      record,
      Buffer.from(art.narrativeEnc),
      fieldAad(collection, 'narrativeEnc'),
    );
    extractedBy = artworkFeatureVersion(kb, ISLAND_PROMPT, deps.artworkModel);
    const result = await extractIslandStory({ kb, model: deps.artworkModel, narrative });
    if (!result.ok) {
      await ref.update({ featureStatus: 'skipped', featureModel: extractedBy });
      logger.warn('story.features_skipped', {
        artworkId: ev.artworkId,
        reason: result.reason,
        attempts: result.attempts,
      });
      return;
    }
    story = result.value;
  } else throw new SkipEvent('no_story_ending');

  const defs = indexDefs(await loadSignalDefs(kb));
  const drafts = islandStorySignals(defs, story, narrative);
  await writeSignals(
    db,
    {
      familyId: record.familyId,
      childId: ev.childId,
      sourceRef: ref.path,
      occurredAt: toDate(art.createdAt),
      kbVersion: kb.version,
      extractedBy,
      now: deps.now(),
    },
    drafts,
  );
  await ref.update({
    'features.storyOutcome': story.storyOutcome,
    featureModel: extractedBy,
    featureStatus: 'done',
  });
  const explicit = await publishExtracted(deps, ev.childId, drafts);
  logger.info('story.features_extracted', {
    artworkId: ev.artworkId,
    signals: drafts.length,
    explicit,
  });
}
