import type { Domain, MoodWeather } from '@ijime/api-types';
import { moodScoresSchema } from '@ijime/kb-loader';
import { SkipEvent, type EventPayload } from '@ijime/service-kit';

import type { SignalWorkerDeps } from './deps.js';
import { homeSignals, indexDefs, moodSignals, type SignalDraft } from './rules.js';
import { childDocPath, loadSignalDefs, writeSignals } from './store.js';

type Ts = { toDate(): Date } | Date;
const toDate = (d: Ts) => (d instanceof Date ? d : d.toDate());

export async function handleCheckinCreated(
  deps: SignalWorkerDeps,
  ev: EventPayload<'checkin.created'>,
): Promise<void> {
  const { db, kb, logger } = deps;
  const snap = await db
    .collectionGroup('children')
    .where('childId', '==', ev.childId)
    .limit(1)
    .get();
  const childDoc = snap.docs[0];
  if (!childDoc) throw new SkipEvent('child_not_found');
  const familyId = childDoc.ref.parent.parent!.id;
  const sources = (childDoc.get('dataSources') ?? {}) as Record<string, boolean>;
  const base = childDocPath(familyId, ev.childId);
  const defs = indexDefs(await loadSignalDefs(kb));

  let drafts: SignalDraft[];
  let sourceRef: string;
  let occurredAt: Date;
  if (ev.kind === 'mood') {
    sourceRef = `${base}/moodCheckins/${ev.checkinId}`;
    const doc = (await db.doc(sourceRef).get()).data() as
      { weather: MoodWeather; createdAt: Ts } | undefined;
    if (!doc) throw new SkipEvent('source_deleted');
    const { scores } = await kb.yaml('rules/mood_scores.yaml', moodScoresSchema);
    occurredAt = toDate(doc.createdAt);
    drafts = moodSignals(defs, scores[doc.weather]);
  } else {
    if (sources['home_checkin'] === false) throw new SkipEvent('data_source_disabled');
    sourceRef = `${base}/homeCheckins/${ev.checkinId}`;
    const doc = (await db.doc(sourceRef).get()).data() as
      { atHome: boolean; checkinAt: Ts } | undefined;
    if (!doc) throw new SkipEvent('source_deleted');
    occurredAt = toDate(doc.checkinAt);
    // 「家にいない」は帰宅時刻ではないため、シグナルを生成しない
    drafts = doc.atHome ? homeSignals(defs, occurredAt) : [];
  }

  await writeSignals(
    db,
    {
      familyId,
      childId: ev.childId,
      sourceRef,
      occurredAt,
      kbVersion: kb.version,
      extractedBy: 'rule',
      now: deps.now(),
    },
    drafts,
  );
  if (drafts.length === 0) return;
  const domains = [...new Set(drafts.map((d) => d.domain))].sort() as Domain[];
  await deps.publisher.publish('signal.extracted', {
    childId: ev.childId,
    domains,
    explicit: false,
  });
  logger.info('checkin.signals', {
    kind: ev.kind,
    checkinId: ev.checkinId,
    signals: drafts.length,
  });
}
