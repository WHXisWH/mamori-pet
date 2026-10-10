import { randomUUID } from 'node:crypto';

import { FieldValue } from '@google-cloud/firestore';
import {
  CHARACTER_IDS,
  DATA_SOURCES,
  GRADE_BANDS,
  MOOD_WEATHERS,
  type AssentRes,
  type CharactersRes,
  type ChildHomeRes,
  type ChildPreferencesBody,
  type ChoosePetRes,
  type DataSourcesBody,
  type MoodWeather,
} from '@ijime/api-types';
import { consultation, island, isCrisisActive, limits } from '@ijime/config';
import { loadGames, type GameCatalog, type Kb } from '@ijime/kb-loader';
import { ApiHttpError, stableId, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';
import {
  islandCurrentPath,
  islandSummary,
  readIslandCurrent,
  ritualsOf,
  ritualsPath,
  touchIsland,
} from './island-store.js';
import { listOfferedRequests } from './pet-requests.js';
import {
  childOwner,
  dataSourcesOf,
  resourceId,
  storedDate,
  updateActiveChild,
} from './workflow-store.js';

const sourcesSchema = z.strictObject({
  dataSources: z.record(z.enum(DATA_SOURCES), z.boolean()),
});
const preferencesSchema = z.strictObject({
  gradeBand: z.enum(GRADE_BANDS),
  nickname: z.string().trim().min(limits.nickname.min).max(limits.nickname.max).optional(),
  ttsEnabled: z.boolean().optional(),
  proactiveEnabled: z.boolean().optional(),
  proactiveSlots: z
    .array(z.enum(['morning', 'after_school', 'bedtime']))
    .max(3)
    .optional(),
});
const petSchema = z.strictObject({
  characterId: z.enum(CHARACTER_IDS),
  petName: z.string().trim().max(limits.petName.max).optional(),
  carryMemoryFrom: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,128}$/)
    .optional(),
});

const CHARACTER_ITEMS: CharactersRes['items'] = [
  {
    characterId: 'moko',
    displayName: 'もこ',
    archetype: 'そっと となりに いる こ',
    palette: { main: '#f2b46d', sub: '#fff1d6' },
    voicePreviewUrl: '',
  },
  {
    characterId: 'pokke',
    displayName: 'ぽっけ',
    archetype: 'げんきに おうえんする こ',
    palette: { main: '#8dc7a7', sub: '#e4f4e8' },
    voicePreviewUrl: '',
  },
  {
    characterId: 'togemaru',
    displayName: 'トゲまる',
    archetype: 'まじめに かんがえる こ',
    palette: { main: '#7c9ad1', sub: '#e6edff' },
    voicePreviewUrl: '',
  },
  {
    characterId: 'nami',
    displayName: 'なみ',
    archetype: 'ゆっくり きいてくれる こ',
    palette: { main: '#7bc4c5', sub: '#e0f7f4' },
    voicePreviewUrl: '',
  },
  {
    characterId: 'hoshi',
    displayName: 'ほし',
    archetype: 'ちいさな いっぽを みつける こ',
    palette: { main: '#d7a5df', sub: '#f7e8fa' },
    voicePreviewUrl: '',
  },
  {
    characterId: 'hidden',
    displayName: 'ひみつの たまご',
    archetype: 'あとで であえる こ',
    palette: { main: '#b6a7d9', sub: '#f0ebff' },
    voicePreviewUrl: '',
  },
];

export function hiddenPetUnlocked(visitDays: number): boolean {
  return visitDays >= (island.stageVisitDays[1] ?? 3);
}

export function consultationIsPending(
  data: Record<string, unknown>,
  now = new Date(),
  options: { childInitiated?: boolean } = {},
): boolean {
  if (
    data['closedAt'] ||
    data['notificationId'] ||
    data['crisisId'] ||
    data['familyHarmSuspected'] ||
    data['followUpAnsweredAt']
  )
    return false;
  // Only an explicit help request can reopen a deferred choice before its reminder is due.
  if (
    options.childInitiated &&
    data['choice'] === 'not_now' &&
    data['level'] === 'l2' &&
    (!data['followUpState'] || ['later', 'talked'].includes(data['followUpState'] as string)) &&
    (!data['followUpAnswer'] || ['not_now', 'talked'].includes(data['followUpAnswer'] as string))
  )
    return true;
  if (data['followUpAnswer'] || data['followUpState']) return false;
  if (!data['choice']) return true;
  const due = storedDate(data['followUpAt']);
  return (
    data['choice'] === 'not_now' &&
    data['level'] === 'l2' &&
    Number(data['offerCount'] ?? 1) < consultation.l2MaxOffers &&
    !!due &&
    due <= now
  );
}

export function registerChildProfile(
  app: ServiceApp,
  getDeps: () => Promise<ChatDeps>,
  getKb: () => Promise<Kb>,
): void {
  const publicRoutes = app as unknown as Hono<ServiceEnv>;
  publicRoutes.get('/v1/characters', (c) => {
    return c.json({ items: CHARACTER_ITEMS } satisfies CharactersRes);
  });
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  let games: Promise<GameCatalog> | undefined;
  const getGames = () => (games ??= getKb().then(loadGames));
  for (const path of ['/home', '/preferences', '/pets', '/data-sources', '/assent', '/characters'])
    r.use(path, async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.get('/characters', async (c) => {
    const deps = await getDeps();
    const { child, base } = await childOwner(deps, c.get('child').childId);
    const catalog = await getGames();
    const current = readIslandCurrent(
      deps.sessions,
      child,
      base,
      (await deps.db.doc(islandCurrentPath(base)).get()).data(),
      catalog,
      new Date(),
    );
    const required = island.stageVisitDays[1] ?? 3;
    return c.json({
      items: [
        ...CHARACTER_ITEMS.map((item) =>
          item.characterId === 'hidden'
            ? {
                ...item,
                locked: !hiddenPetUnlocked(current.visitDays),
                unlockProgress: { current: current.visitDays, required },
              }
            : item,
        ),
      ],
    } satisfies CharactersRes);
  });

  r.get('/home', async (c) => {
    const deps = await getDeps();
    const { child, base, data } = await childOwner(deps, c.get('child').childId);
    const sources = dataSourcesOf(data);
    const moods = await deps.db
      .collection(`${base}/moodCheckins`)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const homeCheckins = sources.home_checkin
      ? await deps.db
          .collection(`${base}/homeCheckins`)
          .where('localDate', '==', today)
          .limit(1)
          .get()
      : undefined;
    const mood = moods.docs[0]?.data();
    const consultations = await deps.db
      .collection(`${base}/consultations`)
      .orderBy('offeredAt', 'desc')
      .limit(limits.pageSize.max)
      .get();
    const pending = consultations.docs.find((d) => consultationIsPending(d.data()));
    const now = new Date();
    const catalog = await getGames();
    const island = await touchIsland(
      { db: deps.db, sessions: deps.sessions, games: catalog },
      child,
      base,
      now,
    );
    const rituals = ritualsOf((await deps.db.doc(ritualsPath(base, today)).get()).data());
    const petRequests = await listOfferedRequests(deps.db, base, catalog, now);
    const proactiveTurns = (
      await deps.db.collection(`${base}/proactiveTurns`).where('localDate', '==', today).get()
    ).docs;
    // Re-read after loading receipts so a concurrent revocation hides older model content.
    const currentOwner = await deps.db.doc(base).get();
    const currentPetId = currentOwner.get('activePetId') ?? child.petId;
    const proactive = proactiveTurns
      .map((doc) => doc.data())
      .filter(
        (turn) =>
          currentPetId === child.petId &&
          turn['petId'] === currentPetId &&
          turn['memoryRevision'] === Number(currentOwner.get('memoryRevision') ?? 0) &&
          (storedDate(turn['modelHistoryResetAt'])?.getTime() ?? 0) ===
            (storedDate(currentOwner.get('modelHistoryResetAt'))?.getTime() ?? 0),
      )
      .sort((a, b) => {
        const millis = (value: unknown) =>
          typeof value === 'object' && value !== null && 'toMillis' in value
            ? Number((value as { toMillis: () => number }).toMillis())
            : Number(value ?? 0);
        return millis(b['createdAt']) - millis(a['createdAt']);
      })[0];
    const activePet = await deps.db.doc(`${base}/pets/${child.petId}`).get();
    const hiddenVariantId = activePet.get('hiddenVariantId');
    const careHotline = await careHotlineFor(deps, base, now);
    const proactiveGreeting = proactive?.['greeting'] as
      { text?: unknown; expression?: unknown } | undefined;
    const body: ChildHomeRes = {
      gradeBand: child.gradeBand,
      pet: {
        petId: child.petId,
        characterId: child.characterId,
        ...(typeof hiddenVariantId === 'string' ? { hiddenVariantId } : {}),
        ...(child.petName ? { petName: child.petName } : {}),
      },
      greeting:
        typeof proactiveGreeting?.text === 'string' &&
        typeof proactiveGreeting.expression === 'string'
          ? {
              text: proactiveGreeting.text,
              expression: proactiveGreeting.expression as ChildHomeRes['greeting']['expression'],
              source: proactive?.['fallback'] === true ? 'template' : 'agent',
            }
          : { text: deps.openings[child.gradeBand][0]!, expression: 'happy', source: 'template' },
      showHomeCheckin: sources.home_checkin && homeCheckins?.empty === true,
      games: [],
      island: islandSummary(island),
      rituals,
      petRequests,
      ...(pending ? { pendingConsultation: { consultationId: pending.id } } : {}),
      ...(careHotline ? { careHotline } : {}),
    };
    // 子どもが家庭内の危害について「いまは安全」と確認した直後：ペットは気づかう表情を保ち、ホームに 189 を固定表示する
    if (careHotline) body.greeting = { ...body.greeting, expression: 'caring' };
    if (mood?.['localDate'] === today && MOOD_WEATHERS.includes(mood['weather'] as MoodWeather))
      body.todayMood = mood['weather'] as MoodWeather;
    return c.json(body);
  });

  r.get('/preferences', async (c) => {
    const { child, data } = await childOwner(await getDeps(), c.get('child').childId);
    const body: ChildPreferencesBody = {
      gradeBand: child.gradeBand,
      nickname: child.nickname,
      ttsEnabled:
        typeof data['ttsEnabled'] === 'boolean' ? data['ttsEnabled'] : child.gradeBand === 'low',
      ...(typeof data['proactiveEnabled'] === 'boolean'
        ? { proactiveEnabled: data['proactiveEnabled'] }
        : {}),
      ...(Array.isArray(data['proactiveSlots'])
        ? {
            proactiveSlots: data['proactiveSlots'].filter(
              (slot): slot is 'morning' | 'after_school' | 'bedtime' =>
                ['morning', 'after_school', 'bedtime'].includes(slot as string),
            ),
          }
        : {}),
    };
    return c.json(body);
  });

  r.put('/preferences', async (c) => {
    const parsed = preferencesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '設定の形式が正しくありません');
    const deps = await getDeps();
    const { ref } = await childOwner(deps, c.get('child').childId);
    await updateActiveChild(deps, ref, { ...parsed.data, updatedAt: new Date() });
    const body: ChildPreferencesBody = {
      gradeBand: parsed.data.gradeBand,
      ...(parsed.data.nickname === undefined ? {} : { nickname: parsed.data.nickname }),
      ...(parsed.data.ttsEnabled === undefined ? {} : { ttsEnabled: parsed.data.ttsEnabled }),
      ...(parsed.data.proactiveEnabled === undefined
        ? {}
        : { proactiveEnabled: parsed.data.proactiveEnabled }),
      ...(parsed.data.proactiveSlots === undefined
        ? {}
        : { proactiveSlots: parsed.data.proactiveSlots }),
    };
    return c.json(body);
  });

  r.get('/data-sources', async (c) => {
    const { data } = await childOwner(await getDeps(), c.get('child').childId);
    return c.json({ dataSources: dataSourcesOf(data) } satisfies DataSourcesBody);
  });

  r.put('/data-sources', async (c) => {
    const parsed = sourcesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '設定の形式が正しくありません');
    const deps = await getDeps();
    const { ref } = await childOwner(deps, c.get('child').childId);
    await updateActiveChild(deps, ref, { ...parsed.data, dataSourcesUpdatedAt: new Date() });
    return c.json(parsed.data satisfies DataSourcesBody);
  });

  r.post('/assent', async (c) => {
    const parsed = sourcesSchema
      .extend({ documentVersion: z.string().trim().min(1).max(100) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '同意の形式が正しくありません');
    const deps = await getDeps();
    const { child, ref } = await childOwner(deps, c.get('child').childId);
    const consentId = `assent-${stableId(child.childId, parsed.data.documentVersion)}`;
    const consent = deps.db.doc(`families/${child.familyId}/consents/${consentId}`);
    await deps.db.runTransaction(async (tx) => {
      const existing = await tx.get(consent);
      const owner = await tx.get(ref);
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (!existing.exists)
        tx.create(consent, {
          type: 'child_assent',
          subjectChildId: child.childId,
          actorId: child.childId,
          documentVersion: parsed.data.documentVersion,
          scope: parsed.data.dataSources,
          grantedAt: new Date(),
        });
      tx.update(ref, {
        assentComplete: true,
        assentVersion: parsed.data.documentVersion,
        dataSources: parsed.data.dataSources,
      });
    });
    return c.json({ consentId } satisfies AssentRes, 201);
  });

  r.post('/pets', async (c) => {
    const parsed = petSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', 'パートナーを選んでください');
    const deps = await getDeps();
    const { child, base, ref } = await childOwner(deps, c.get('child').childId);
    let hiddenVariantId: string | undefined;
    if (parsed.data.characterId === 'hidden') {
      const catalog = await getGames();
      const current = readIslandCurrent(
        deps.sessions,
        child,
        base,
        (await deps.db.doc(islandCurrentPath(base)).get()).data(),
        catalog,
        new Date(),
      );
      if (!hiddenPetUnlocked(current.visitDays))
        throw new ApiHttpError(
          'PERMISSION_DENIED',
          'ひみつのたまごは、もう少し島で過ごしてから選べます',
        );
      hiddenVariantId = `hidden-${stableId(child.childId, 'hidden')}`;
    }
    const idempotency = c.req.header('Idempotency-Key');
    if (idempotency) resourceId(idempotency);
    const petId = idempotency ? `pet-${stableId(child.childId, idempotency)}` : randomUUID();
    const petRef = deps.db.doc(`${base}/pets/${petId}`);
    const requestHash = stableId(
      parsed.data.characterId,
      parsed.data.petName ?? '',
      parsed.data.carryMemoryFrom ?? '',
    );
    await deps.db.runTransaction(async (tx) => {
      const owner = await tx.get(ref);
      const existing = await tx.get(petRef);
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (existing.exists) {
        if (existing.get('requestHash') !== requestHash)
          throw new ApiHttpError('ALREADY_EXISTS', 'このリクエストは処理済みです');
        return;
      }
      const active = await tx.get(deps.db.collection(`${base}/pets`).where('active', '==', true));
      const source = parsed.data.carryMemoryFrom
        ? await tx.get(deps.db.doc(`${base}/pets/${parsed.data.carryMemoryFrom}`))
        : undefined;
      if (source && !source.exists)
        throw new ApiHttpError('NOT_FOUND', 'パートナーが見つかりません');
      const memories = await tx.get(deps.db.collection(`${base}/memories`));
      if (memories.size + active.size > 450)
        throw new ApiHttpError('RATE_LIMITED', '保存された記憶が多いため、先に整理してください');
      for (const pet of active.docs) tx.update(pet.ref, { active: false });
      for (const memory of memories.docs) {
        const data = memory.data();
        const ownerPet = data['petId'] as string | undefined;
        const legacySource =
          !ownerPet && (!data['characterId'] || data['characterId'] === source?.get('characterId'));
        if (source && (ownerPet === source.id || legacySource))
          tx.update(memory.ref, {
            petId,
            characterId: parsed.data.characterId,
            carriedAt: new Date(),
          });
        else if (!ownerPet)
          tx.update(memory.ref, {
            petId: child.petId,
            characterId: data['characterId'] ?? child.characterId,
          });
      }
      tx.create(petRef, {
        requestHash,
        characterId: parsed.data.characterId,
        petName: parsed.data.petName ?? '',
        active: true,
        createdAt: new Date(),
        ...(hiddenVariantId ? { hiddenVariantId } : {}),
        ...(source ? { memoryCarriedFrom: source.id } : {}),
      });
      tx.update(ref, { activePetId: petId, agentSummary: FieldValue.delete() });
    });
    return c.json(
      {
        petId,
        characterId: parsed.data.characterId,
        ...(hiddenVariantId ? { hiddenVariantId } : {}),
      } satisfies ChoosePetRes,
      201,
    );
  });
}

// 子どもが安全ページで家庭内の危害について安全を確認してから 24 時間以内（イベントは進行中のままだが、子どもはロックしない）は、ホームに 189 を固定表示する（2026-10-10 決定）
async function careHotlineFor(deps: ChatDeps, base: string, now: Date) {
  const events = await deps.db
    .collection(`${base}/crisisEvents`)
    .where('status', '==', 'child_acknowledged')
    .get();
  if (!events.docs.some((d) => isCrisisActive(d.data(), now))) return undefined;
  return deps.hotlines.find((r) => r.id === 'jidou_soudan');
}
