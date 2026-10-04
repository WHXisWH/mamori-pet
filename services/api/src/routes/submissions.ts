import type { ArtworkRes, GradeBand, HomeCheckinRes, IslandRes, MoodRes } from '@ijime/api-types';
import { MOOD_WEATHERS } from '@ijime/api-types';
import { limits, retention } from '@ijime/config';
import { fieldAad } from '@ijime/crypto';
import type { ChildReplies, GameCatalog, PetRequestReplies } from '@ijime/kb-loader';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import type { ArtworkFeatureClient, ArtworkImageStore } from '../artwork-io.js';
import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';
import { persistSubmission } from '../submission-store.js';
import { FieldValue } from '@google-cloud/firestore';
import { islandPutSchema, readJson, saveIsland } from './island.js';
import { markRitual } from './island-store.js';
import { artworkDate, artworkFamilySafe, isOwnArtworkImage } from './shared-artworks.js';
import { checkNarrative, raiseCrisis, submissionOwner as owner } from './submission-guard.js';
import { resourceId } from './workflow-store.js';
import { consumeArtwork } from '../model-budget.js';

export type SubmissionDeps = Pick<
  ChatDeps,
  | 'db'
  | 'sessions'
  | 'directory'
  | 'detector'
  | 'safeModeCopy'
  | 'hotlines'
  | 'auth'
  | 'logger'
  | 'publish'
> & {
  replies: ChildReplies;
  petRequestReplies: PetRequestReplies;
  // kb/games：お題、アイテムのカタログ、季節
  games: GameCatalog;
  images: ArtworkImageStore;
  artworkFeatures: ArtworkFeatureClient;
  now: () => Date;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 日本にはサマータイムがないため、+9 時間で固定
function jst(d: Date): { localDate: string; localHour: number } {
  const t = new Date(d.getTime() + 9 * 3_600_000);
  return { localDate: t.toISOString().slice(0, 10), localHour: t.getUTCHours() };
}

const narrativeText = z.string().max(limits.narrativeText.max);
const moodSchema = z.object({ weather: z.enum(MOOD_WEATHERS) });
const homeSchema = z.object({ atHome: z.boolean(), method: z.enum(['geo', 'manual']) });
const artworkFieldsSchema = z.object({
  type: z.enum(['drawing', 'self_portrait', 'story']),
  promptId: z.string().min(1).max(64).optional(),
  requestId: z.string().min(1).max(128).optional(),
  narrativeText: narrativeText.optional(),
  narrativeMode: z.enum(['typed', 'voice_transcript']),
  save: z.enum(['true', 'false']),
});

function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function registerSubmissions(app: ServiceApp, getDeps: () => Promise<SubmissionDeps>): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  for (const p of ['/mood', '/home-checkins', '/artworks', '/artworks/*', '/island-scenes'])
    r.use(p, async (c, next) => childAuth((await getDeps()).auth)(c, next));

  const reply = (lines: Record<GradeBand, string>, g: GradeBand) => lines[g];

  r.post('/mood', async (c) => {
    const deps = await getDeps();
    const { weather } = await readJson(c.req.raw, moodSchema, '天気を選んでください');
    const { child, base } = await owner(deps, c.get('child').childId);
    const now = deps.now();
    const ref = deps.db.collection(`${base}/moodCheckins`).doc();
    await persistSubmission(deps.db, base, ref, { weather, ...jst(now), createdAt: now });
    await markRitual(deps.db, base, jst(now).localDate, 'morningMood', now);
    await deps.publish('checkin.created', {
      childId: child.childId,
      kind: 'mood',
      checkinId: ref.id,
    });
    const body: MoodRes = {
      checkinId: ref.id,
      petReply: reply(deps.replies.mood[weather], child.gradeBand),
    };
    return c.json(body, 201);
  });

  r.post('/home-checkins', async (c) => {
    const deps = await getDeps();
    const req = await readJson(c.req.raw, homeSchema, '形式が正しくありません');
    const { child, base, sources } = await owner(deps, c.get('child').childId);
    if (req.method === 'geo' && sources['home_checkin'] === false)
      throw new ApiHttpError('DATA_SOURCE_DISABLED', 'きたくの せっていが オフに なっています');
    const now = deps.now();
    const ref = deps.db.collection(`${base}/homeCheckins`).doc();
    await persistSubmission(deps.db, base, ref, {
      atHome: req.atHome,
      method: req.method,
      localDate: jst(now).localDate,
      checkinAt: now,
    });
    if (req.atHome) await markRitual(deps.db, base, jst(now).localDate, 'okaeri', now);
    await deps.publish('checkin.created', {
      childId: child.childId,
      kind: 'home',
      checkinId: ref.id,
    });
    const body: HomeCheckinRes = {
      checkinId: ref.id,
      greeting: reply(deps.replies.home[req.atHome ? 'at_home' : 'not_home'], child.gradeBand),
    };
    return c.json(body, 201);
  });

  r.post('/artworks', async (c) => {
    const deps = await getDeps();
    const form = await c.req.parseBody().catch(() => null);
    if (!form) throw new ApiHttpError('INVALID_ARGUMENT', '形式が正しくありません');
    const fields = artworkFieldsSchema.safeParse({
      type: form['type'],
      promptId:
        typeof form['promptId'] === 'string' && form['promptId'] ? form['promptId'] : undefined,
      requestId:
        typeof form['requestId'] === 'string' && form['requestId'] ? form['requestId'] : undefined,
      narrativeText: typeof form['narrativeText'] === 'string' ? form['narrativeText'] : undefined,
      narrativeMode: form['narrativeMode'],
      save: form['save'],
    });
    const image = form['image'];
    if (!fields.success || !(image instanceof File))
      throw new ApiHttpError('INVALID_ARGUMENT', '形式が正しくありません');
    if (image.size > limits.artworkImageMaxBytes)
      throw new ApiHttpError('INVALID_ARGUMENT', '画像が大きすぎます');
    const png = Buffer.from(await image.arrayBuffer());
    const size = pngSize(png);
    if (!size) throw new ApiHttpError('INVALID_ARGUMENT', 'PNG 画像を送ってください');
    if (Math.max(size.width, size.height) > limits.artworkImageMaxEdgePx)
      throw new ApiHttpError('INVALID_ARGUMENT', '画像が大きすぎます');

    const f = fields.data;
    const { child, base, sources } = await owner(deps, c.get('child').childId);
    const narrative = f.narrativeText ?? '';
    await consumeArtwork(deps.db, base, deps.now());
    const check = await checkNarrative(deps, child, narrative);

    const collection = `${base}/artworks`;
    const ref = deps.db.collection(collection).doc();
    // お絵かきの保存がオフのときは原画を保存しない
    const save = f.save === 'true' && sources['artwork_save'] !== false;
    const imageRef = save ? `${collection}/${ref.id}.png` : undefined;
    if (imageRef) await deps.images.save(imageRef, png);
    const now = deps.now();
    await persistSubmission(deps.db, base, ref, {
      type: f.type,
      ...(f.type === 'story' && f.promptId ? { promptId: f.promptId } : {}),
      ...(f.requestId ? { requestId: resourceId(f.requestId) } : {}),
      ...(imageRef ? { imageRef } : {}),
      ...(narrative
        ? {
            narrativeEnc: deps.sessions.encryptForChild(
              child,
              narrative,
              fieldAad(collection, 'narrativeEnc'),
            ),
            narrativeMode: f.narrativeMode,
          }
        : {}),
      features: {},
      featureModel: '',
      featureStatus: check?.hit ? 'skipped' : 'pending',
      sharedWithGuardian: false,
      createdAt: now,
      expireAt: new Date(now.getTime() + retention.artworksDays * 86_400_000),
    });

    const body: ArtworkRes = {
      artworkId: ref.id,
      petPrompt: reply(
        deps.replies.artwork[f.type === 'story' ? 'story' : 'self_portrait'],
        child.gradeBand,
      ),
    };
    if (check?.hit) {
      body.crisis = await raiseCrisis(deps, child, 'artwork', ref.path, check);
      return c.json(body, 201);
    }
    try {
      await deps.artworkFeatures({
        familyId: child.familyId,
        childId: child.childId,
        artworkId: ref.id,
        image: { mimeType: 'image/png', data: png.toString('base64') },
      });
    } catch (err) {
      // 特徴抽出の失敗は提出に影響しない：その作品は採点しない（docs/02-agent-architecture.md）
      deps.logger.warn('artwork.features_call_failed', {
        artworkId: ref.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
    }
    return c.json(body, 201);
  });

  r.post('/artworks/:artworkId/share', async (c) => {
    const deps = await getDeps();
    const { base } = await owner(deps, c.get('child').childId);
    const id = resourceId(c.req.param('artworkId'));
    const ref = deps.db.doc(`${base}/artworks/${id}`);
    await deps.db.runTransaction(async (tx) => {
      const active = await tx.get(deps.db.doc(base));
      const snap = await tx.get(ref);
      if (active.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      const expireAt = artworkDate(snap.get('expireAt'));
      if (!snap.exists || !expireAt || expireAt <= deps.now())
        throw new ApiHttpError('NOT_FOUND', '作品が見つかりません');
      if (!isOwnArtworkImage(base, id, snap.get('imageRef')))
        throw new ApiHttpError('INVALID_ARGUMENT', 'この絵は保存されていません');
      if (!(await artworkFamilySafe(tx, deps.db, base)))
        throw new ApiHttpError('PERMISSION_DENIED', 'いまは みせられないよ');
      if (snap.get('sharedWithGuardian') !== true || !artworkDate(snap.get('sharedAt')))
        tx.update(ref, { sharedWithGuardian: true, sharedAt: deps.now() });
    });
    c.header('Cache-Control', 'no-store');
    return c.body(null, 204);
  });

  // Revocation blocks future URL issuance, not images already delivered or unexpired signed URLs.
  r.delete('/artworks/:artworkId/share', async (c) => {
    const deps = await getDeps();
    const { base } = await owner(deps, c.get('child').childId);
    const ref = deps.db.doc(`${base}/artworks/${resourceId(c.req.param('artworkId'))}`);
    await deps.db.runTransaction(async (tx) => {
      const active = await tx.get(deps.db.doc(base));
      const snap = await tx.get(ref);
      if (active.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (snap.exists) tx.update(ref, { sharedWithGuardian: false, sharedAt: FieldValue.delete() });
    });
    c.header('Cache-Control', 'no-store');
    return c.body(null, 204);
  });

  // 互換性のために残す：同じ機能は PUT /v1/child/island が受け持つ（docs/04-backend-api.md）
  r.post('/island-scenes', async (c) => {
    const deps = await getDeps();
    const req = await readJson(c.req.raw, islandPutSchema, '形式が正しくありません');
    if (req.items.length < limits.islandItems.min)
      throw new ApiHttpError('INVALID_ARGUMENT', '形式が正しくありません');
    const { child, base } = await owner(deps, c.get('child').childId);
    const saved = await saveIsland(deps, child, base, req);
    const body: IslandRes = {
      sceneId: saved.sceneId,
      petPrompt: reply(deps.replies.island, child.gradeBand),
      ...(saved.crisis ? { crisis: saved.crisis } : {}),
    };
    return c.json(body, 201);
  });
}
