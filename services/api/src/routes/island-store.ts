import type { DocumentData, Firestore, Transaction } from '@google-cloud/firestore';
import type { ChildRecord, FirestoreSessionService } from '@ijime/agent-core';
import type { DailyRituals, IslandItem, IslandSummary } from '@ijime/api-types';
import { island as islandConfig, limits } from '@ijime/config';
import { fieldAad } from '@ijime/crypto';
import { seasonFor, type GameCatalog, type IslandSeason } from '@ijime/kb-loader';
import { z } from 'zod';

import { storedDate } from './workflow-store.js';

// children/:childId/island/current（docs/03-database.md）。全体を上書きで書き込む
export type IslandCurrent = {
  items: IslandItem[];
  selfFigureId?: string;
  decorations: string[];
  unlockedItems: string[];
  visitDays: number;
  lastVisitDate: string;
  season: IslandSeason;
  goodThingCount: number;
};

export const islandItemSchema = z.object({
  id: z.string().min(1).max(64),
  catalogId: z.string().min(1).max(64),
  category: z.string().min(1).max(32),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  rotation: z.number().finite(),
  layer: z.number().int().min(0).max(1000),
});
export const islandItemsSchema = z.array(islandItemSchema).max(limits.islandItems.max);
const sceneGraphSchema = z.object({ items: islandItemsSchema });

export const islandPath = (base: string) => `${base}/island`;
export const islandCurrentPath = (base: string) => `${islandPath(base)}/current`;

export function jstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function stageOf(visitDays: number): number {
  return Math.max(
    1,
    islandConfig.stageVisitDays.filter((threshold) => visitDays >= threshold).length,
  );
}

export function encodeScene(
  sessions: FirestoreSessionService,
  child: ChildRecord,
  collection: string,
  items: readonly IslandItem[],
): Buffer {
  return sessions.encryptForChild(
    child,
    JSON.stringify({ items }),
    fieldAad(collection, 'sceneGraphEnc'),
  );
}

export function decodeScene(
  sessions: FirestoreSessionService,
  child: ChildRecord,
  collection: string,
  enc: unknown,
): IslandItem[] {
  if (!enc) return [];
  const raw: unknown = JSON.parse(
    sessions.decryptForChild(
      child,
      Buffer.from(enc as Uint8Array),
      fieldAad(collection, 'sceneGraphEnc'),
    ),
  );
  const parsed = sceneGraphSchema.safeParse(raw);
  return parsed.success ? parsed.data.items : [];
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export function readIslandCurrent(
  sessions: FirestoreSessionService,
  child: ChildRecord,
  base: string,
  data: DocumentData | undefined,
  games: GameCatalog,
  now: Date,
): IslandCurrent {
  const season = seasonFor(games.seasons, now);
  if (!data)
    return {
      items: [],
      decorations: [],
      unlockedItems: [],
      visitDays: 0,
      lastVisitDate: '',
      season,
      goodThingCount: 0,
    };
  const selfFigureId = typeof data['selfFigureId'] === 'string' ? data['selfFigureId'] : undefined;
  return {
    items: decodeScene(sessions, child, islandPath(base), data['sceneGraphEnc']),
    ...(selfFigureId ? { selfFigureId } : {}),
    decorations: strings(data['decorations']),
    unlockedItems: strings(data['unlockedItems']),
    visitDays: typeof data['visitDays'] === 'number' ? data['visitDays'] : 0,
    lastVisitDate: typeof data['lastVisitDate'] === 'string' ? data['lastVisitDate'] : '',
    season,
    goodThingCount: typeof data['goodThingCount'] === 'number' ? data['goodThingCount'] : 0,
  };
}

// 来訪日数は日本時間の日付で数える。連続日数ではない（docs/03-database.md）
export function visited(current: IslandCurrent, now: Date): IslandCurrent {
  const today = jstDate(now);
  if (current.lastVisitDate === today) return current;
  return { ...current, visitDays: current.visitDays + 1, lastVisitDate: today };
}

export function islandDoc(
  sessions: FirestoreSessionService,
  child: ChildRecord,
  base: string,
  current: IslandCurrent,
  now: Date,
): DocumentData {
  return {
    sceneGraphEnc: encodeScene(sessions, child, islandPath(base), current.items),
    ...(current.selfFigureId ? { selfFigureId: current.selfFigureId } : {}),
    decorations: current.decorations,
    unlockedItems: current.unlockedItems,
    visitDays: current.visitDays,
    lastVisitDate: current.lastVisitDate,
    season: current.season,
    goodThingCount: current.goodThingCount,
    updatedAt: now,
  };
}

export type IslandStoreDeps = {
  db: Firestore;
  sessions: FirestoreSessionService;
  games: GameCatalog;
};

export async function loadIslandInTx(
  tx: Transaction,
  deps: IslandStoreDeps,
  child: ChildRecord,
  base: string,
  now: Date,
): Promise<IslandCurrent> {
  const snap = await tx.get(deps.db.doc(islandCurrentPath(base)));
  return readIslandCurrent(deps.sessions, child, base, snap.data(), deps.games, now);
}

// 読み込んで来訪を1回記録する。子どもが active 状態でないときは書き込まない
export async function touchIsland(
  deps: IslandStoreDeps,
  child: ChildRecord,
  base: string,
  now: Date,
): Promise<IslandCurrent> {
  return deps.db.runTransaction(async (tx) => {
    const owner = await tx.get(deps.db.doc(base));
    const current = await loadIslandInTx(tx, deps, child, base, now);
    const next = visited(current, now);
    if (owner.get('status') === 'active' && next !== current)
      tx.set(
        deps.db.doc(islandCurrentPath(base)),
        islandDoc(deps.sessions, child, base, next, now),
      );
    return next;
  });
}

export function islandSummary(current: IslandCurrent): IslandSummary {
  return {
    visitDays: current.visitDays,
    stage: stageOf(current.visitDays),
    season: current.season,
    decorationCount: current.decorations.length,
  };
}

export const RITUAL_FIELDS = ['morningMood', 'okaeri', 'goodThing', 'watered'] as const;
export type RitualField = (typeof RITUAL_FIELDS)[number];

export function ritualsOf(data: DocumentData | undefined): DailyRituals {
  const flag = (f: RitualField) => data?.[f] === true;
  const sticker = data?.['bodySticker'];
  return {
    morningMood: flag('morningMood'),
    ...(typeof sticker === 'string'
      ? { bodySticker: sticker as NonNullable<DailyRituals['bodySticker']> }
      : {}),
    okaeri: flag('okaeri'),
    goodThing: flag('goodThing'),
    watered: flag('watered'),
  };
}

export const ritualsPath = (base: string, localDate: string) => `${base}/dailyRituals/${localDate}`;

// 真偽値だけを書き込み、内容は記録しない（docs/03-database.md dailyRituals）
export function markRitualInTx(
  tx: Transaction,
  db: Firestore,
  base: string,
  localDate: string,
  existing: DocumentData | undefined,
  field: RitualField,
  now: Date,
): DailyRituals {
  const before = ritualsOf(existing);
  const after: DailyRituals = {
    morningMood: before.morningMood || field === 'morningMood',
    okaeri: before.okaeri || field === 'okaeri',
    goodThing: before.goodThing || field === 'goodThing',
    watered: before.watered || field === 'watered',
    ...(before.bodySticker ? { bodySticker: before.bodySticker } : {}),
  };
  tx.set(db.doc(ritualsPath(base, localDate)), {
    localDate,
    morningMood: after.morningMood,
    okaeri: after.okaeri,
    goodThing: after.goodThing,
    watered: after.watered,
    ...(after.bodySticker ? { bodySticker: after.bodySticker } : {}),
    updatedAt: now,
  });
  return after;
}

export async function markRitual(
  db: Firestore,
  base: string,
  localDate: string,
  field: RitualField,
  now: Date,
): Promise<void> {
  await db.runTransaction(async (tx) => {
    const owner = await tx.get(db.doc(base));
    if (owner.get('status') !== 'active') return;
    const snap = await tx.get(db.doc(ritualsPath(base, localDate)));
    if (snap.get(field) === true) return;
    markRitualInTx(tx, db, base, localDate, snap.data(), field, now);
  });
}

export function notExpired(data: DocumentData | undefined, field: string, now: Date): boolean {
  const at = storedDate(data?.[field]);
  return at === undefined || at > now;
}
