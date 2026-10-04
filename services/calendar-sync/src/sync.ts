import type { DocumentReference, Firestore } from '@google-cloud/firestore';
import type { ContextCategory } from '@ijime/api-types';
import { calendar as calendarConfig } from '@ijime/config';
import { fieldAad } from '@ijime/crypto';
import { contextKeywordsSchema } from '@ijime/kb-loader';
import { InvalidGrantError } from '@ijime/service-kit';

import { createClassifier, linkChildren, type Classifier, type LinkableChild } from './classify.js';
import type { CalendarSyncDeps } from './deps.js';
import { eventDates, externalEventHash, overlaps, syncWindow, type SyncWindow } from './dates.js';

export const KEYWORDS_PATH = 'rules/context_keywords.yaml';

export function refreshTokenAad(familyId: string, guardianId: string): string {
  return fieldAad(`families/${familyId}/calendarConnections/${guardianId}`, 'refreshTokenEnc');
}

export function calendarEventDocId(hash: string): string {
  return `cal-${hash.slice(0, 40)}`;
}

export type SyncResult = { connections: number; failed: number; revoked: number };

type Connection = {
  ref: DocumentReference;
  familyId: string;
  guardianId: string;
  calendarIds: string[];
  refreshTokenEnc: Buffer;
};

type ContextDoc = {
  childIds: string[];
  category: ContextCategory;
  source: 'calendar';
  startDate: string;
  endDate: string;
  externalEventHash: string;
  createdBy: string;
};

type FamilyChild = LinkableChild & { calendarOn: boolean };

async function familyChildren(db: Firestore, familyId: string): Promise<FamilyChild[]> {
  const snap = await db.collection(`families/${familyId}/children`).get();
  return snap.docs.flatMap((doc) => {
    const d = doc.data();
    if (d['status'] && d['status'] !== 'active') return [];
    const sources = (d['dataSources'] ?? {}) as Record<string, boolean>;
    return [
      {
        childId: (d['childId'] as string | undefined) ?? doc.id,
        nickname: String(d['nickname'] ?? ''),
        calendarOn: sources['calendar'] !== false,
      },
    ];
  });
}

// 予定のタイトルは、ここでメモリ上の種別と子どもの判定に使うだけで、ドキュメントにもログにも書き込まない
async function collect(
  deps: CalendarSyncDeps,
  conn: Connection,
  classify: Classifier,
  window: SyncWindow,
): Promise<Map<string, ContextDoc>> {
  const refreshToken = await deps.vault.open(
    conn.refreshTokenEnc,
    refreshTokenAad(conn.familyId, conn.guardianId),
  );
  const accessToken = await deps.calendar.accessToken(refreshToken);
  const children = await familyChildren(deps.db, conn.familyId);
  // カレンダーのデータソースを無効にした子どもも、ニックネームの照合には含める（紐づけはしない）。そうしないと、その子の名前が書かれた予定がきょうだいに紐づいてしまう
  const off = new Set(children.filter((c) => !c.calendarOn).map((c) => c.childId));
  const docs = new Map<string, ContextDoc>();
  if (off.size === children.length) return docs;
  for (const calendarId of conn.calendarIds) {
    const events = await deps.calendar.listEvents(accessToken, calendarId, window);
    for (const ev of events) {
      if (ev.status === 'cancelled' || !ev.summary) continue;
      const category = classify(ev.summary);
      const dates = eventDates(ev);
      if (!category || !dates || !overlaps(dates, window)) continue;
      const childIds = linkChildren(ev.summary, children).filter((id) => !off.has(id));
      if (!childIds.length) continue;
      const hash = externalEventHash(calendarId, ev.id);
      docs.set(calendarEventDocId(hash), {
        childIds,
        category,
        source: 'calendar',
        ...dates,
        externalEventHash: hash,
        createdBy: conn.guardianId,
      });
    }
  }
  return docs;
}

async function apply(
  db: Firestore,
  conn: Connection,
  docs: Map<string, ContextDoc>,
  window: SyncWindow,
): Promise<void> {
  const col = db.collection(`families/${conn.familyId}/contextEvents`);
  const existing = await col
    .where('createdBy', '==', conn.guardianId)
    .where('source', '==', 'calendar')
    .get();
  const writer = db.bulkWriter();
  for (const [id, doc] of docs) void writer.set(col.doc(id), doc);
  for (const snap of existing.docs) {
    const d = snap.data() as ContextDoc;
    if (!docs.has(snap.id) && overlaps(d, window)) void writer.delete(snap.ref);
  }
  await writer.close();
}

function toConnection(ref: DocumentReference, d: Record<string, unknown>): Connection | null {
  const familyId = ref.parent.parent?.id;
  const enc = d['refreshTokenEnc'];
  if (!familyId || !enc || !Array.isArray(d['calendarIds'])) return null;
  return {
    ref,
    familyId,
    guardianId: ref.id,
    calendarIds: d['calendarIds'] as string[],
    refreshTokenEnc: Buffer.from(enc as Uint8Array),
  };
}

export async function runSync(deps: CalendarSyncDeps): Promise<SyncResult> {
  const classify = createClassifier(await deps.kb.yaml(KEYWORDS_PATH, contextKeywordsSchema));
  const window = syncWindow(deps.now(), calendarConfig.syncPastDays, calendarConfig.syncFutureDays);
  const snap = await deps.db
    .collectionGroup('calendarConnections')
    .where('status', '==', 'active')
    .get();
  const result: SyncResult = { connections: 0, failed: 0, revoked: 0 };
  for (const doc of snap.docs) {
    const conn = toConnection(doc.ref, doc.data());
    if (!conn) continue;
    result.connections++;
    try {
      const docs = await collect(deps, conn, classify, window);
      await apply(deps.db, conn, docs, window);
      await conn.ref.update({ lastSyncAt: deps.now() });
      deps.logger.info('calendar.synced', { familyId: conn.familyId, events: docs.size });
    } catch (err) {
      const revoked = err instanceof InvalidGrantError;
      if (revoked) result.revoked++;
      else result.failed++;
      deps.logger.warn('calendar.sync_failed', {
        familyId: conn.familyId,
        reason: revoked ? 'invalid_grant' : err instanceof Error ? err.name : 'unknown',
      });
      await conn.ref.update({ status: revoked ? 'revoked' : 'error' }).catch(() => undefined);
    }
  }
  return result;
}
