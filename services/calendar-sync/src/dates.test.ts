import { describe, expect, it } from 'vitest';

import { eventDates, externalEventHash, overlaps, syncWindow } from './dates.js';

const ev = (start: object, end: object) => ({ id: 'e', start, end });

describe('eventDates', () => {
  it('treats the all-day end date as exclusive', () => {
    expect(eventDates(ev({ date: '2026-07-20' }, { date: '2026-07-21' }))).toEqual({
      startDate: '2026-07-20',
      endDate: '2026-07-20',
    });
    expect(eventDates(ev({ date: '2026-07-20' }, { date: '2026-08-31' }))).toEqual({
      startDate: '2026-07-20',
      endDate: '2026-08-30',
    });
  });

  it('uses the Japan date for timed events', () => {
    // UTC の前日 15:30 = 日本時間 00:30
    expect(
      eventDates(ev({ dateTime: '2026-11-19T15:30:00Z' }, { dateTime: '2026-11-19T17:00:00Z' })),
    ).toEqual({ startDate: '2026-11-20', endDate: '2026-11-20' });
  });

  it('does not spill into the next day when ending exactly at midnight JST', () => {
    expect(
      eventDates(
        ev({ dateTime: '2026-11-20T09:00:00+09:00' }, { dateTime: '2026-11-21T00:00:00+09:00' }),
      ),
    ).toEqual({ startDate: '2026-11-20', endDate: '2026-11-20' });
  });

  it('spans multiple days for multi-day timed events', () => {
    expect(
      eventDates(
        ev({ dateTime: '2026-10-05T08:00:00+09:00' }, { dateTime: '2026-10-07T18:00:00+09:00' }),
      ),
    ).toEqual({ startDate: '2026-10-05', endDate: '2026-10-07' });
  });

  it('returns null for unparseable times', () => {
    expect(eventDates(ev({}, {}))).toBeNull();
    expect(eventDates(ev({ dateTime: 'x' }, { dateTime: 'y' }))).toBeNull();
  });
});

describe('syncWindow', () => {
  it('is anchored on the Japan date', () => {
    const w = syncWindow(new Date('2026-11-19T16:00:00Z'), 7, 60);
    expect(w.startDate).toBe('2026-11-13');
    expect(w.endDate).toBe('2027-01-19');
    expect(w.timeMin).toBe('2026-11-13T00:00:00+09:00');
    expect(w.timeMax).toBe('2027-01-20T00:00:00+09:00');
  });
});

describe('externalEventHash', () => {
  it('is stable and distinguishes calendars', () => {
    expect(externalEventHash('cal', 'e1')).toBe(externalEventHash('cal', 'e1'));
    expect(externalEventHash('cal', 'e1')).not.toBe(externalEventHash('cal2', 'e1'));
    expect(externalEventHash('ab', 'c')).not.toBe(externalEventHash('a', 'bc'));
    expect(externalEventHash('cal', 'e1')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('overlaps', () => {
  it('includes touching ranges', () => {
    const w = { startDate: '2026-11-13', endDate: '2027-01-19' };
    expect(overlaps({ startDate: '2026-11-01', endDate: '2026-11-13' }, w)).toBe(true);
    expect(overlaps({ startDate: '2026-11-01', endDate: '2026-11-12' }, w)).toBe(false);
  });
});
