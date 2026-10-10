import { describe, expect, it } from 'vitest';

import {
  ACTIVE_CRISIS_STATUSES,
  crisisAcknowledgedAt,
  isCrisisActive,
  isCrisisLockingChild,
} from './crisis-lifecycle.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const timestamp = (d: Date) => ({ toDate: () => d });

describe('crisis lifecycle', () => {
  it('treats open and unknown events as active', () => {
    expect(isCrisisActive({ status: 'open' }, NOW)).toBe(true);
    expect(isCrisisActive({}, NOW)).toBe(true);
    expect(isCrisisActive({ status: 'something_new' }, NOW)).toBe(true);
  });

  it('treats closed events as inactive', () => {
    expect(isCrisisActive({ status: 'closed' }, NOW)).toBe(false);
  });

  it('keeps an acknowledged event active for 24 hours after the acknowledgement', () => {
    const ack = (h: number) => ({
      status: 'guardian_acknowledged',
      timeline: [
        { step: 'detected', at: timestamp(hoursAgo(h + 1)) },
        { step: 'guardian_acknowledged', at: timestamp(hoursAgo(h)) },
      ],
    });
    expect(isCrisisActive(ack(23.9), NOW)).toBe(true);
    expect(isCrisisActive(ack(24), NOW)).toBe(false);
    expect(isCrisisActive(ack(48), NOW)).toBe(false);
  });

  it('fails closed when an acknowledged event has no readable acknowledgement time', () => {
    expect(isCrisisActive({ status: 'guardian_acknowledged' }, NOW)).toBe(true);
    expect(
      isCrisisActive(
        { status: 'guardian_acknowledged', timeline: [{ step: 'guardian_acknowledged' }] },
        NOW,
      ),
    ).toBe(true);
  });

  it('starts the clock at the first acknowledgement and accepts plain dates', () => {
    const event = {
      timeline: [
        { step: 'guardian_acknowledged', at: hoursAgo(30) },
        { step: 'guardian_acknowledged', at: timestamp(hoursAgo(2)) },
      ],
    };
    expect(crisisAcknowledgedAt(event)?.getTime()).toBe(hoursAgo(30).getTime());
    expect(isCrisisActive({ status: 'guardian_acknowledged', ...event }, NOW)).toBe(false);
  });
});

describe('family-harm crisis closure (decided 2026-10-10)', () => {
  const daysAgo = (d: number) => hoursAgo(d * 24);

  it('keeps an open family-harm event active until 7 days after detection, then closes it', () => {
    const open = (days: number) => ({
      status: 'open',
      familyHarmSuspected: true,
      createdAt: timestamp(daysAgo(days)),
    });
    expect(isCrisisActive(open(6.9), NOW)).toBe(true);
    expect(isCrisisActive(open(7), NOW)).toBe(false);
    expect(isCrisisLockingChild(open(7), NOW)).toBe(false);
  });

  it('never expires an open event that is not family harm or has no readable detection time', () => {
    expect(
      isCrisisActive({ status: 'open', familyHarmSuspected: false, createdAt: daysAgo(30) }, NOW),
    ).toBe(true);
    expect(isCrisisActive({ status: 'open', familyHarmSuspected: true }, NOW)).toBe(true);
  });

  it('unlocks the child right after the child acknowledges, but stays active for guardians for 24 hours', () => {
    const acked = (h: number) => ({
      status: 'child_acknowledged',
      familyHarmSuspected: true,
      createdAt: daysAgo(1),
      timeline: [{ step: 'child_acknowledged', at: hoursAgo(h) }],
    });
    expect(isCrisisLockingChild(acked(0.1), NOW)).toBe(false);
    expect(isCrisisActive(acked(0.1), NOW)).toBe(true);
    expect(isCrisisActive(acked(23.9), NOW)).toBe(true);
    expect(isCrisisActive(acked(24), NOW)).toBe(false);
    expect(crisisAcknowledgedAt(acked(5))?.getTime()).toBe(hoursAgo(5).getTime());
  });

  it('keeps locking the child while only a guardian has acknowledged', () => {
    const event = {
      status: 'guardian_acknowledged',
      timeline: [{ step: 'guardian_acknowledged', at: hoursAgo(1) }],
    };
    expect(isCrisisLockingChild(event, NOW)).toBe(true);
    expect(isCrisisLockingChild({ status: 'open' }, NOW)).toBe(true);
    expect(isCrisisLockingChild({ status: 'closed' }, NOW)).toBe(false);
  });

  it('lists every status that may still be active', () => {
    expect(ACTIVE_CRISIS_STATUSES).toEqual(['open', 'guardian_acknowledged', 'child_acknowledged']);
  });
});
