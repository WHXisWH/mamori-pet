import { FieldValue, type DocumentData, type Firestore } from '@google-cloud/firestore';
import type { ChildRecord } from '@ijime/agent-core';
import type {
  PetRequest,
  PetRequestCompleteRes,
  PetRequestDeclineRes,
  PetRequestType,
  PetRequestsRes,
} from '@ijime/api-types';
import { PET_REQUEST_TYPES } from '@ijime/api-types';
import { limits, retention } from '@ijime/config';
import { fieldAad } from '@ijime/crypto';
import type { CrisisCheck } from '@ijime/crisis-detector';
import {
  findGamePrompt,
  promptOptions,
  promptText,
  type GameCatalog,
  type GamePrompt,
} from '@ijime/kb-loader';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { childAuth, type AuthEnv } from '../auth.js';
import { consultationIsPending } from './child-profile.js';
import { readJson } from './island.js';
import { islandCurrentPath, islandDoc, loadIslandInTx } from './island-store.js';
import { artworkDate, isOwnArtworkImage } from './shared-artworks.js';
import { checkNarrative, raiseCrisis, submissionOwner } from './submission-guard.js';
import type { SubmissionDeps } from './submissions.js';
import { resourceId, storedDate } from './workflow-store.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const endingText = z.string().min(1).max(limits.narrativeText.max);
export const completeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('drawing'), artworkId: id }),
  z.object({
    type: z.literal('story'),
    artworkId: id.optional(),
    ending: z
      .object({ mode: z.enum(['typed', 'voice_transcript', 'option']), text: endingText })
      .optional(),
  }),
  z.object({ type: z.literal('pet_worry'), optionId: z.string().min(1).max(64) }),
]);

export const petRequestsPath = (base: string) => `${base}/petRequests`;

export function toPetRequest(
  games: GameCatalog,
  requestId: string,
  data: DocumentData,
): PetRequest | undefined {
  const type = data['type'] as PetRequestType;
  if (!PET_REQUEST_TYPES.includes(type) || typeof data['promptId'] !== 'string') return undefined;
  const game = findGamePrompt(games, type, data['promptId']);
  const offeredAt = storedDate(data['offeredAt']);
  const expiresAt = storedDate(data['expiresAt']);
  if (!game || !offeredAt || !expiresAt || typeof data['rewardItemId'] !== 'string')
    return undefined;
  const options = promptOptions(game);
  return {
    requestId,
    type,
    promptId: data['promptId'],
    promptText: promptText(game),
    ...(options ? { options } : {}),
    rewardItemId: data['rewardItemId'],
    offeredAt: offeredAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function listOfferedRequests(
  db: Firestore,
  base: string,
  games: GameCatalog,
  now: Date,
): Promise<PetRequest[]> {
  const snap = await db
    .collection(petRequestsPath(base))
    .where('status', '==', 'offered')
    .limit(limits.pageSize.max)
    .get();
  return snap.docs
    .filter((d) => (storedDate(d.get('expiresAt')) ?? now) > now)
    .flatMap((d) => {
      const item = toPetRequest(games, d.id, d.data());
      return item ? [item] : [];
    })
    .sort((a, b) => b.offeredAt.localeCompare(a.offeredAt));
}

type Completion = {
  resultRef: string;
  petReply: string;
  artworkPath?: string;
  publishStory: boolean;
};

function replyFor(
  deps: SubmissionDeps,
  child: ChildRecord,
  game: GamePrompt,
  optionId?: string,
): string {
  if (game.type === 'pet_worry') {
    const option = game.prompt.options.find((o) => o.id === optionId);
    return option?.kind === 'tell_adult'
      ? deps.petRequestReplies.tell_adult[child.gradeBand]
      : game.prompt.reply_ja;
  }
  return deps.petRequestReplies[game.type][child.gradeBand];
}

export function registerPetRequests(app: ServiceApp, getDeps: () => Promise<SubmissionDeps>): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child/pet-requests');
  r.use('*', async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.get('/', async (c) => {
    const deps = await getDeps();
    const { base } = await submissionOwner(deps, c.get('child').childId);
    const body: PetRequestsRes = {
      items: await listOfferedRequests(deps.db, base, deps.games, deps.now()),
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  r.post('/:requestId/complete', async (c) => {
    const deps = await getDeps();
    const requestId = resourceId(c.req.param('requestId'));
    const req = await readJson(c.req.raw, completeSchema, '形式が正しくありません');
    const { child, base } = await submissionOwner(deps, c.get('child').childId);
    const now = deps.now();
    const requestRef = deps.db.doc(`${petRequestsPath(base)}/${requestId}`);
    const before = (await requestRef.get()).data();
    if (!before || (storedDate(before['expiresAt']) ?? now) <= now)
      throw new ApiHttpError('NOT_FOUND', 'お願いが見つかりません');
    if (before['type'] !== req.type)
      throw new ApiHttpError('INVALID_ARGUMENT', 'お願いの種類が違います');
    const game = findGamePrompt(deps.games, req.type, String(before['promptId']));
    if (!game) throw new ApiHttpError('NOT_FOUND', 'お願いが見つかりません');

    // 結末のテキストは子どもの入力なので、先に危機検知を通す。選択肢は定型の文言
    let check: CrisisCheck | undefined;
    let endingNarrative = '';
    let endingOutcome: string | undefined;
    if (req.type === 'story' && req.ending) {
      if (game.type !== 'story')
        throw new ApiHttpError('INVALID_ARGUMENT', 'お願いの種類が違います');
      if (req.ending.mode === 'option') {
        const option = game.prompt.ending_options.find(
          (o) => o.id === req.ending!.text || o.text_ja === req.ending!.text,
        );
        if (!option) throw new ApiHttpError('INVALID_ARGUMENT', 'おわりかたを選んでください');
        endingOutcome = option.outcome;
      } else {
        endingNarrative = req.ending.text;
        check = await checkNarrative(deps, child, endingNarrative);
      }
    }

    const artworks = `${base}/artworks`;
    const result = await deps.db.runTransaction(async (tx): Promise<Completion> => {
      const owner = await tx.get(deps.db.doc(base));
      const request = await tx.get(requestRef);
      const island = await loadIslandInTx(tx, deps, child, base, now);
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      const data = request.data();
      if (!data) throw new ApiHttpError('NOT_FOUND', 'お願いが見つかりません');
      const rewardItemId = String(data['rewardItemId']);
      if (data['status'] === 'completed')
        return {
          resultRef: String(data['resultRef'] ?? ''),
          petReply: replyFor(
            deps,
            child,
            game,
            req.type === 'pet_worry' ? String(data['resultRef']) : undefined,
          ),
          publishStory: false,
        };
      if (data['status'] !== 'offered')
        throw new ApiHttpError('NOT_FOUND', 'お願いが見つかりません');

      const decorations = [...island.decorations];
      let completion: Completion;
      if (req.type === 'drawing') {
        const art = await tx.get(deps.db.doc(`${artworks}/${req.artworkId}`));
        const expireAt = artworkDate(art.get('expireAt'));
        if (
          !art.exists ||
          !expireAt ||
          expireAt <= now ||
          !['drawing', 'self_portrait'].includes(String(art.get('type')))
        )
          throw new ApiHttpError('INVALID_ARGUMENT', '絵が見つかりません');
        tx.update(art.ref, { requestId });
        if (
          isOwnArtworkImage(base, req.artworkId, art.get('imageRef')) &&
          !decorations.includes(req.artworkId)
        )
          decorations.push(req.artworkId);
        completion = {
          resultRef: req.artworkId,
          petReply: replyFor(deps, child, game),
          publishStory: false,
        };
      } else if (req.type === 'story') {
        if (!req.artworkId && !req.ending)
          throw new ApiHttpError('INVALID_ARGUMENT', '絵かおわりかたを送ってください');
        const featureStatus = check?.hit ? 'skipped' : endingOutcome ? 'done' : 'pending';
        const outcome = endingOutcome ? { storyOutcome: endingOutcome } : {};
        const narrative = endingNarrative
          ? {
              narrativeEnc: deps.sessions.encryptForChild(
                child,
                endingNarrative,
                fieldAad(artworks, 'narrativeEnc'),
              ),
              narrativeMode: req.ending!.mode,
            }
          : {};
        let artworkRef = req.artworkId ? deps.db.doc(`${artworks}/${req.artworkId}`) : undefined;
        if (artworkRef) {
          const art = await tx.get(artworkRef);
          const expireAt = artworkDate(art.get('expireAt'));
          if (!art.exists || !expireAt || expireAt <= now || art.get('type') !== 'story')
            throw new ApiHttpError('INVALID_ARGUMENT', '絵が見つかりません');
          tx.update(artworkRef, {
            requestId,
            promptId: game.prompt.id,
            ...(art.get('narrativeEnc') ? {} : narrative),
            ...(endingOutcome
              ? { 'features.storyOutcome': endingOutcome, storyOutcomeSource: 'option' }
              : {}),
            ...(check?.hit ? { featureStatus: 'skipped' } : {}),
          });
        } else {
          artworkRef = deps.db.collection(artworks).doc();
          tx.create(artworkRef, {
            type: 'story',
            requestId,
            promptId: game.prompt.id,
            ...narrative,
            features: outcome,
            featureModel: '',
            featureStatus,
            ...(endingOutcome ? { storyOutcomeSource: 'option' } : {}),
            sharedWithGuardian: false,
            createdAt: now,
            expireAt: new Date(now.getTime() + retention.artworksDays * 86_400_000),
          });
        }
        completion = {
          resultRef: artworkRef.id,
          petReply: replyFor(deps, child, game),
          artworkPath: artworkRef.path,
          publishStory: !check?.hit && (!!endingOutcome || !!endingNarrative),
        };
      } else {
        if (game.type !== 'pet_worry')
          throw new ApiHttpError('INVALID_ARGUMENT', 'お願いの種類が違います');
        const option = game.prompt.options.find((o) => o.id === req.optionId);
        if (!option) throw new ApiHttpError('INVALID_ARGUMENT', 'こたえを選んでください');
        if (option.kind === 'tell_adult') {
          const openCrisis = await tx.get(
            deps.db
              .collection(`${base}/crisisEvents`)
              .where('status', 'in', ['open', 'guardian_acknowledged'])
              .limit(1),
          );
          const recent = await tx.get(
            deps.db
              .collection(`${base}/consultations`)
              .orderBy('offeredAt', 'desc')
              .limit(limits.pageSize.max),
          );
          const pending = recent.docs.find((d) => consultationIsPending(d.data(), now));
          if (openCrisis.empty && !pending) {
            tx.create(deps.db.doc(`${base}/consultations/req-${requestId}`), {
              assessmentId: 'child-request',
              level: 'l2',
              source: 'child',
              petRequestId: requestId,
              offeredAt: now,
              offerCount: 1,
            });
            tx.update(deps.db.doc(base), { consultationRevision: FieldValue.increment(1) });
          }
        }
        completion = {
          resultRef: option.id,
          petReply: replyFor(deps, child, game, option.id),
          publishStory: false,
        };
      }

      tx.update(requestRef, {
        status: 'completed',
        completedAt: now,
        resultRef: completion.resultRef,
      });
      tx.set(
        deps.db.doc(islandCurrentPath(base)),
        islandDoc(
          deps.sessions,
          child,
          base,
          {
            ...island,
            decorations,
            unlockedItems: island.unlockedItems.includes(rewardItemId)
              ? island.unlockedItems
              : [...island.unlockedItems, rewardItemId],
          },
          now,
        ),
      );
      return completion;
    });

    const body: PetRequestCompleteRes = {
      rewardItemId: String(before['rewardItemId']),
      petReply: result.petReply,
    };
    if (check?.hit)
      body.crisis = await raiseCrisis(
        deps,
        child,
        'artwork',
        result.artworkPath ?? requestRef.path,
        check,
      );
    else if (result.publishStory)
      await deps.publish('artwork.created', {
        childId: child.childId,
        artworkId: result.resultRef,
        type: 'story',
      });
    c.header('Cache-Control', 'no-store');
    return c.json(body, 200);
  });

  r.post('/:requestId/decline', async (c) => {
    const deps = await getDeps();
    const requestId = resourceId(c.req.param('requestId'));
    const { base } = await submissionOwner(deps, c.get('child').childId);
    const ref = deps.db.doc(`${petRequestsPath(base)}/${requestId}`);
    await deps.db.runTransaction(async (tx) => {
      const owner = await tx.get(deps.db.doc(base));
      const snap = await tx.get(ref);
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (!snap.exists) throw new ApiHttpError('NOT_FOUND', 'お願いが見つかりません');
      if (snap.get('status') === 'offered')
        tx.update(ref, { status: 'declined', declinedAt: deps.now() });
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true } satisfies PetRequestDeclineRes);
  });
}
