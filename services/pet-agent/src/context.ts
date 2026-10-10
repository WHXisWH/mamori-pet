import type { Firestore } from '@google-cloud/firestore';
import {
  childPath,
  type ChildContext,
  type ChildRecord,
  type FirestoreSessionService,
} from '@ijime/agent-core';
import { agent, consultation } from '@ijime/config';
import { holidaysSchema, weeklyReportSentencesSchema, type Kb } from '@ijime/kb-loader';

export function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function')
    return value.toDate() as Date;
  return undefined;
}

export function jstParts(now: Date) {
  const shifted = new Date(now.getTime() + 9 * 3_600_000);
  return {
    date: shifted.toISOString().slice(0, 10),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
  };
}

export function consultationPending(
  data: Record<string, unknown>,
  now: Date,
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
  // The child's change of mind does not have to wait for an unsolicited reminder.
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
  const followUp = asDate(data['followUpAt']);
  return (
    data['choice'] === 'not_now' &&
    data['level'] !== 'l3' &&
    typeof data['offerCount'] === 'number' &&
    data['offerCount'] < consultation.l2MaxOffers &&
    followUp !== undefined &&
    followUp <= now
  );
}

function attemptTime(data: Record<string, unknown>): number {
  return Math.max(
    ...['offeredAt', 'choiceAt', 'followUpUpdatedAt'].map((field) => dateTime(data[field])),
  );
}

function dateTime(value: unknown): number {
  const time = asDate(value)?.getTime();
  return time !== undefined && Number.isFinite(time) ? time : 0;
}

function helpAttempt(
  data: Record<string, unknown>,
  now: Date,
): NonNullable<ChildContext['helpAttempt']> {
  const choice = data['choice'];
  const storedState = data['followUpState'];
  const answer = data['followUpAnswer'];
  const state =
    storedState === 'talked' ||
    storedState === 'later' ||
    storedState === 'needs_help' ||
    storedState === 'supported' ||
    storedState === 'paused'
      ? storedState
      : answer === 'talked' || answer === 'supported'
        ? answer
        : answer === 'not_now'
          ? 'later'
          : answer === 'need_help' ||
              (data['source'] === 'child_followup' && data['followUpReason'] === 'need_help')
            ? 'needs_help'
            : 'unknown';
  const due = asDate(data['followUpAt']);
  return {
    ...(choice === 'self' || choice === 'proxy' || choice === 'not_now' ? { choice } : {}),
    state,
    followUp:
      state === 'supported' || state === 'paused' || data['followUpAnsweredAt'] || data['closedAt']
        ? 'stopped'
        : due && Number.isFinite(due.getTime())
          ? due > now
            ? 'scheduled'
            : 'due'
          : 'unscheduled',
  };
}

export async function readChildContext(
  db: Firestore,
  kb: Kb,
  child: ChildRecord,
  now = new Date(),
  sessions?: FirestoreSessionService,
): Promise<ChildContext> {
  const base = childPath(child.familyId, child.childId);
  const data = (await db.doc(base).get()).data() ?? {};
  const collection = db.collection(`${base}/consultations`);
  // An older attempt can have the newest child answer. Each query uses a single-field index.
  const snapshots = await Promise.all(
    ['offeredAt', 'choiceAt', 'followUpUpdatedAt'].map((field) =>
      collection.orderBy(field, 'desc').limit(agent.contextHistoryTurns).get(),
    ),
  );
  const consultations = [
    ...new Map(snapshots.flatMap((s) => s.docs).map((d) => [d.id, d])).values(),
  ].sort(
    (a, b) =>
      attemptTime(b.data()) - attemptTime(a.data()) ||
      dateTime(b.get('offeredAt')) - dateTime(a.get('offeredAt')) ||
      a.id.localeCompare(b.id),
  );
  const pending = consultations.find((d) => consultationPending(d.data(), now));
  const jst = jstParts(now);
  const holidays = await kb.yaml('resources/jp_holidays.yaml', holidaysSchema);
  const contextEvents = await db
    .collection(`families/${child.familyId}/contextEvents`)
    .where('childIds', 'array-contains', child.childId)
    .where('endDate', '>=', jst.date)
    .get();
  const vacation = contextEvents.docs.some((d) => {
    const e = d.data();
    return (
      e['category'] === 'long_vacation' && e['startDate'] <= jst.date && e['endDate'] >= jst.date
    );
  });
  // Only a separately approved, non-quoted summary may enter model context.
  const summary = data['agentSummary'] as
    | { approved?: boolean; petId?: string; text?: unknown; textEnc?: unknown; expiresAt?: unknown }
    | undefined;
  const summaryExpiry = asDate(summary?.expiresAt);
  let recentTrend = '';
  if (
    summary?.approved === true &&
    summary.petId === child.petId &&
    (!data['activePetId'] || data['activePetId'] === child.petId) &&
    summaryExpiry &&
    summaryExpiry > now
  ) {
    try {
      recentTrend = (
        summary.textEnc && sessions
          ? sessions.decryptForChild(
              child,
              Buffer.from(summary.textEnc as Uint8Array),
              `${base}#agentSummary.textEnc`,
            )
          : typeof summary.text === 'string'
            ? summary.text
            : ''
      ).slice(0, agent.contextStatusChars);
    } catch {
      // Corrupt or wrong-child ciphertext never becomes prompt text.
    }
  }
  if (!recentTrend) {
    const report = (
      await db.collection(`${base}/weeklyReports`).orderBy('generatedAt', 'desc').limit(1).get()
    ).docs[0]?.data();
    const generatedAt = asDate(report?.['generatedAt']);
    if (
      generatedAt &&
      generatedAt <= now &&
      now.getTime() - generatedAt.getTime() < 7 * 86_400_000 &&
      typeof report?.['summaryText'] === 'string'
    ) {
      const { sentences } = await kb.yaml(
        'templates/weekly_report.ja.yaml',
        weeklyReportSentencesSchema,
      );
      const parts = report['summaryText'].match(/[^。]+。/gu) ?? [];
      if (
        parts.length > 0 &&
        parts.join('') === report['summaryText'] &&
        parts.every((part) => sentences.some((sentence) => sentence.text_ja === part))
      )
        recentTrend = report['summaryText'].slice(0, agent.contextStatusChars);
    }
  }
  const result: ChildContext = {
    gradeBand: child.gradeBand,
    characterId: child.characterId,
    localTime: new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(now),
    dayType:
      [0, 6].includes(jst.weekday) || vacation || holidays.holidays.some((h) => h.date === jst.date)
        ? 'day_off'
        : 'school_day',
    recentTrend,
    careFlag: data['careFlag'] === true,
  };
  if (consultations[0]) result.helpAttempt = helpAttempt(consultations[0].data(), now);
  if (pending) {
    result.pendingConsultationId = pending.id;
    const due = asDate(pending.data()['followUpAt']);
    if (due) result.followUpAt = due.toISOString();
  }
  return result;
}
