import { jstClock } from '@/components/island/time';

export function restRhythm(now = new Date()): { night: boolean; nextChangeMs: number } {
  const { hour } = jstClock(now);
  const night = hour >= 23 || hour < 5;
  const next = new Date(now);
  // JST has no daylight saving: 23:00 is 14:00 UTC and 05:00 is 20:00 UTC.
  next.setUTCHours(night ? 20 : 14, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return { night, nextChangeMs: next.getTime() - now.getTime() };
}
