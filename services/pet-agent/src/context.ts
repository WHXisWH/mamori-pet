import type { Firestore } from '@google-cloud/firestore';
import { childPath, type ChildContext, type ChildRecord } from '@ijime/agent-core';
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

export function consultationPending(data: Record<string, unknown>, now: Date): boolean {
  if (data['closedAt'] || data['notificationId']) return false;
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

export async function readChildContext(
  db: Firestore,
  kb: Kb,
  child: ChildRecord,
  now = new Date(),
): Promise<ChildContext> {
  const base = childPath(child.familyId, child.childId);
  const data = (await db.doc(base).get()).data() ?? {};
  const consultations = await db
    .collection(`${base}/consultations`)
    .orderBy('offeredAt', 'desc')
    .limit(agent.contextHistoryTurns)
    .get();
  const pending = consultations.docs.find((d) => consultationPending(d.data(), now));
  const jst = jstParts(now);
  const holidays = await kb.yaml('resources/jp_holidays.yaml', holidaysSchema);
  const contextEvents = await db
    .collection(`families/${child.familyId}/contextEvents`)
    .where('childIds', 'array-contains', child.childId)
    .get();
  const vacation = contextEvents.docs.some((d) => {
    const e = d.data();
    return (
      e['category'] === 'long_vacation' && e['startDate'] <= jst.date && e['endDate'] >= jst.date
    );
  });
  // Only a separately approved, non-quoted summary may enter model context.
  const summary = data['agentSummary'] as
    { approved?: boolean; text?: unknown; expiresAt?: unknown } | undefined;
  const summaryExpiry = asDate(summary?.expiresAt);
  let recentTrend =
    summary?.approved === true &&
    typeof summary.text === 'string' &&
    summaryExpiry !== undefined &&
    summaryExpiry > now
      ? summary.text.slice(0, agent.contextStatusChars)
      : '';
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
  if (pending) {
    result.pendingConsultationId = pending.id;
    const due = asDate(pending.data()['followUpAt']);
    if (due) result.followUpAt = due.toISOString();
  }
  return result;
}
