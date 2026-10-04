import type { ChildRecord } from '@ijime/agent-core';
import type {
  CrisisPayload,
  IslandCatalogItem,
  IslandItem,
  IslandPutRes,
  IslandStateRes,
} from '@ijime/api-types';
import { limits, retention } from '@ijime/config';
import { fieldAad } from '@ijime/crypto';
import { islandItemAvailable } from '@ijime/kb-loader';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { ARTWORK_URL_TTL_MS } from '../artwork-io.js';
import { childAuth, type AuthEnv } from '../auth.js';
import {
  encodeScene,
  islandCurrentPath,
  islandDoc,
  islandItemsSchema,
  loadIslandInTx,
  stageOf,
  visited,
  type IslandCurrent,
} from './island-store.js';
import { artworkDate, isOwnArtworkImage } from './shared-artworks.js';
import { checkNarrative, raiseCrisis, submissionOwner } from './submission-guard.js';
import type { SubmissionDeps } from './submissions.js';

export const islandPutSchema = z.object({
  selfFigureId: z.string().min(1).max(64).optional(),
  items: islandItemsSchema,
  narrative: z
    .object({
      mode: z.enum(['typed', 'voice_transcript']),
      text: z.string().max(limits.narrativeText.max),
    })
    .optional(),
});
export type IslandPutInput = z.infer<typeof islandPutSchema>;

export async function readJson<T>(req: Request, schema: z.ZodType<T>, message: string): Promise<T> {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', message);
  return parsed.data;
}

export function spriteUrl(sprite: string): string {
  return `/island/${sprite}`;
}

export function islandCatalog(deps: SubmissionDeps, current: IslandCurrent): IslandCatalogItem[] {
  return deps.games.islandItems.map((entry) => ({
    catalogId: entry.catalogId,
    category: entry.category,
    label: entry.label_ja,
    spriteUrl: spriteUrl(entry.sprite),
    locked: !islandItemAvailable(entry, current),
  }));
}

export function validateIslandItems(
  deps: Pick<SubmissionDeps, 'games'>,
  req: Pick<IslandPutInput, 'items' | 'selfFigureId'>,
  previous: IslandCurrent,
): void {
  const ids = new Set(req.items.map((i) => i.id));
  if (ids.size !== req.items.length)
    throw new ApiHttpError('INVALID_ARGUMENT', '同じ ID の物があります');
  if (req.selfFigureId !== undefined && !ids.has(req.selfFigureId))
    throw new ApiHttpError('INVALID_ARGUMENT', '「これがわたし」を選んでください');
  const kept = new Set(previous.items.map((i) => `${i.id}:${i.catalogId}`));
  for (const item of req.items) {
    const entry = deps.games.islandItems.find((e) => e.catalogId === item.catalogId);
    if (!entry || entry.category !== item.category)
      throw new ApiHttpError('INVALID_ARGUMENT', '知らない物があります');
    if (!islandItemAvailable(entry, previous) && !kept.has(`${item.id}:${item.catalogId}`))
      throw new ApiHttpError('INVALID_ARGUMENT', 'まだ使えない物があります');
  }
}

export type SavedIsland = { sceneId: string; crisis?: CrisisPayload };

// レイアウトの保存：island/current 全体を上書きし、islandScenes にスナップショットを1件残す（docs/04-backend-api.md PUT /v1/child/island）
export async function saveIsland(
  deps: SubmissionDeps,
  child: ChildRecord,
  base: string,
  req: IslandPutInput,
): Promise<SavedIsland> {
  const narrative = req.narrative?.text ?? '';
  const check = await checkNarrative(deps, child, narrative);
  const now = deps.now();
  const collection = `${base}/islandScenes`;
  const sceneRef = deps.db.collection(collection).doc();

  await deps.db.runTransaction(async (tx) => {
    const owner = await tx.get(deps.db.doc(base));
    const previousScene = await tx.get(
      deps.db.collection(collection).orderBy('createdAt', 'desc').limit(1),
    );
    const current = await loadIslandInTx(tx, deps, child, base, now);
    if (owner.get('status') !== 'active')
      throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
    validateIslandItems(deps, req, current);
    const previousSceneId = previousScene.docs[0]?.id;
    tx.create(sceneRef, {
      sceneGraphEnc: encodeScene(deps.sessions, child, collection, req.items),
      ...(req.selfFigureId ? { selfFigureId: req.selfFigureId } : {}),
      ...(previousSceneId ? { previousSceneId } : {}),
      ...(narrative
        ? {
            narrativeEnc: deps.sessions.encryptForChild(
              child,
              narrative,
              fieldAad(collection, 'narrativeEnc'),
            ),
            narrativeMode: req.narrative!.mode,
          }
        : {}),
      features: {},
      createdAt: now,
      expireAt: new Date(now.getTime() + retention.islandScenesDays * 86_400_000),
    });
    const next: IslandCurrent = {
      ...visited(current, now),
      items: req.items as IslandItem[],
      ...(req.selfFigureId ? { selfFigureId: req.selfFigureId } : {}),
    };
    if (!req.selfFigureId) delete next.selfFigureId;
    tx.set(deps.db.doc(islandCurrentPath(base)), islandDoc(deps.sessions, child, base, next, now));
  });

  if (check?.hit)
    return {
      sceneId: sceneRef.id,
      crisis: await raiseCrisis(deps, child, 'island', sceneRef.path, check),
    };
  await deps.publish('artwork.created', {
    childId: child.childId,
    artworkId: sceneRef.id,
    type: 'island',
  });
  return { sceneId: sceneRef.id };
}

async function decorations(
  deps: SubmissionDeps,
  base: string,
  current: IslandCurrent,
  now: Date,
): Promise<IslandStateRes['decorations']> {
  if (!deps.images.readUrl || current.decorations.length === 0) return [];
  const out: IslandStateRes['decorations'] = [];
  for (const artworkId of current.decorations.slice(0, limits.pageSize.max)) {
    const snap = await deps.db.doc(`${base}/artworks/${artworkId}`).get();
    const expireAt = artworkDate(snap.get('expireAt'));
    if (!snap.exists || !expireAt || expireAt <= now) continue;
    if (!isOwnArtworkImage(base, artworkId, snap.get('imageRef'))) continue;
    const thumbnailUrl = await deps.images.readUrl(
      snap.get('imageRef') as string,
      new Date(Math.min(expireAt.getTime(), now.getTime() + ARTWORK_URL_TTL_MS)),
    );
    if (thumbnailUrl) out.push({ artworkId, thumbnailUrl });
  }
  return out;
}

export function registerIsland(app: ServiceApp, getDeps: () => Promise<SubmissionDeps>): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  r.use('/island', async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.get('/island', async (c) => {
    const deps = await getDeps();
    const { child, base } = await submissionOwner(deps, c.get('child').childId);
    const now = deps.now();
    const current = await deps.db.runTransaction(async (tx) => {
      const loaded = await loadIslandInTx(tx, deps, child, base, now);
      const next = visited(loaded, now);
      if (next !== loaded)
        tx.set(
          deps.db.doc(islandCurrentPath(base)),
          islandDoc(deps.sessions, child, base, next, now),
        );
      return next;
    });
    const body: IslandStateRes = {
      items: current.items,
      ...(current.selfFigureId ? { selfFigureId: current.selfFigureId } : {}),
      decorations: await decorations(deps, base, current, now),
      unlockedItems: current.unlockedItems,
      catalog: islandCatalog(deps, current),
      visitDays: current.visitDays,
      stage: stageOf(current.visitDays),
      season: current.season,
      goodThingCount: current.goodThingCount,
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  r.put('/island', async (c) => {
    const deps = await getDeps();
    const req = await readJson(c.req.raw, islandPutSchema, '形式が正しくありません');
    const { child, base } = await submissionOwner(deps, c.get('child').childId);
    const saved = await saveIsland(deps, child, base, req);
    const body: IslandPutRes = {
      sceneId: saved.sceneId,
      ...(saved.crisis ? { crisis: saved.crisis } : {}),
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body, 200);
  });
}
