import { createHash } from 'node:crypto';

import type { CalendarEvent, CalendarEventTime } from '@ijime/service-kit';

const JST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 86400_000;

export function jstDate(t: Date): string {
  return new Date(t.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export type SyncWindow = { startDate: string; endDate: string; timeMin: string; timeMax: string };

// 日本時間の日付で区切る：[today - past, today + future]。両端を含む
export function syncWindow(now: Date, pastDays: number, futureDays: number): SyncWindow {
  const today = jstDate(now);
  const startDate = addDays(today, -pastDays);
  const endDate = addDays(today, futureDays);
  return {
    startDate,
    endDate,
    timeMin: `${startDate}T00:00:00+09:00`,
    timeMax: `${addDays(endDate, 1)}T00:00:00+09:00`,
  };
}

function instant(t: CalendarEventTime): Date | null {
  if (!t.dateTime) return null;
  const d = new Date(t.dateTime);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 終日の予定の end.date は当日を含まない。時刻つきの予定は日本時間で日付を取り、ちょうど 0 時に終わる予定は翌日に数えない
export function eventDates(ev: CalendarEvent): { startDate: string; endDate: string } | null {
  if (ev.start.date && ev.end.date) {
    const endDate = addDays(ev.end.date, -1);
    return { startDate: ev.start.date, endDate: endDate < ev.start.date ? ev.start.date : endDate };
  }
  const start = instant(ev.start);
  const end = instant(ev.end);
  if (!start || !end) return null;
  const startDate = jstDate(start);
  const endDate = jstDate(new Date(Math.max(start.getTime(), end.getTime() - 1)));
  return { startDate, endDate };
}

export function externalEventHash(calendarId: string, eventId: string): string {
  return createHash('sha256').update(calendarId).update('\n').update(eventId).digest('hex');
}

export function overlaps(
  a: { startDate: string; endDate: string },
  b: { startDate: string; endDate: string },
): boolean {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}
