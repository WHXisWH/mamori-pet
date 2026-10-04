import { client } from '@ijime/config';

import type { TimeOfDay } from './sprites';

export function jstClock(now = new Date()): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '12') % 24;
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  return { hour, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd) };
}

export function timeOfDay(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 10) return 'morning';
  if (hour >= 10 && hour < 16) return 'day';
  if (hour >= 16 && hour < 19) return 'evening';
  return 'night';
}

export const BEDTIME_START_HOUR = client.islandBedtimeStartHour;

export function isBedtime(hour: number): boolean {
  return hour >= BEDTIME_START_HOUR || hour < 5;
}
