import type { ContextCategory } from '@ijime/api-types';

export type DayType = 'school' | 'rest';

export type ContextSpan = { category: ContextCategory; startDate: string; endDate: string };

const DAY_MS = 86_400_000;

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export function jstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function contextsOn(date: string, spans: readonly ContextSpan[]): ContextCategory[] {
  return [
    ...new Set(
      spans.filter((s) => s.startDate <= date && date <= s.endDate).map((s) => s.category),
    ),
  ].sort();
}

export function dayType(
  date: string,
  holidays: ReadonlySet<string>,
  spans: readonly ContextSpan[],
  restContexts: readonly ContextCategory[],
): DayType {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6 || holidays.has(date)) return 'rest';
  if (contextsOn(date, spans).some((c) => restContexts.includes(c))) return 'rest';
  return 'school';
}
