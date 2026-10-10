import { afterEach, describe, expect, it, vi } from 'vitest';
import { PubSubRestPublisher, type GoogleHttp } from '@ijime/service-kit';
import { consultationPending, jstParts } from './context.js';
import { createEventPublisher, modelMode } from './runtime.js';

describe('context guards', () => {
  it('uses the JST date and weekday across UTC midnight', () => {
    expect(jstParts(new Date('2026-10-02T16:00:00Z'))).toEqual({
      date: '2026-10-03',
      hour: 1,
      weekday: 6,
    });
  });
  it('respects pending, future, due, already shared and maximum follow-up states', () => {
    const now = new Date('2026-10-01T00:00:00Z');
    expect(consultationPending({}, now)).toBe(true);
    expect(consultationPending({ choice: 'proxy' }, now)).toBe(false);
    expect(consultationPending({ notificationId: 'n' }, now)).toBe(false);
    expect(
      consultationPending(
        { choice: 'not_now', level: 'l2', offerCount: 1, followUpAt: new Date('2026-10-02') },
        now,
      ),
    ).toBe(false);
    expect(
      consultationPending(
        { choice: 'not_now', level: 'l2', offerCount: 1, followUpAt: new Date(0) },
        now,
      ),
    ).toBe(true);
    expect(
      consultationPending(
        { choice: 'not_now', level: 'l2', offerCount: 3, followUpAt: new Date(0) },
        now,
      ),
    ).toBe(false);
    expect(
      consultationPending(
        { choice: 'not_now', level: 'l3', offerCount: 1, followUpAt: new Date(0) },
        now,
      ),
    ).toBe(false);
  });
  it('never silently chooses a scripted model in production', () => {
    expect(modelMode({ NODE_ENV: 'production' })).toBe('vertex');
    expect(() => modelMode({ NODE_ENV: 'production', PET_MODEL_MODE: 'scripted' })).toThrow(
      'vertex',
    );
    expect(() => modelMode({ PET_MODEL_MODE: 'typo' })).toThrow('invalid');
    expect(modelMode({ PET_MODEL_MODE: 'scripted' })).toBe('scripted');
  });
  it.each([{}, { followUpAnswer: 'not_now', followUpState: 'later', followUpRound: 1 }])(
    'allows only a child-initiated early return to an unfinished not_now attempt: %j',
    (followup) => {
      const now = new Date('2026-10-07');
      const data = {
        level: 'l2',
        choice: 'not_now',
        offerCount: 1,
        followUpAt: new Date('2026-10-10'),
        ...followup,
      };
      expect(consultationPending(data, now)).toBe(false);
      expect(consultationPending(data, now, { childInitiated: true })).toBe(true);
    },
  );
  it.each([
    { followUpAnsweredAt: new Date(0) },
    { followUpState: 'supported' },
    { followUpState: 'paused' },
    { followUpState: 'needs_help' },
    { closedAt: new Date(0) },
    { notificationId: 'sent' },
    { crisisId: 'crisis' },
    { familyHarmSuspected: true },
    { level: 'l3' },
  ])('does not resume a terminal or unsafe attempt: %j', (guard) => {
    const data = {
      level: 'l2',
      choice: 'not_now',
      offerCount: 1,
      followUpAt: new Date(0),
      ...guard,
    };
    expect(consultationPending(data, new Date(), { childInitiated: true })).toBe(false);
  });
  it.each([
    { followUpAnsweredAt: new Date(0) },
    { followUpAnswer: 'talked' },
    { followUpAnswer: 'not_now' },
    { followUpState: 'supported' },
    { followUpState: 'paused' },
  ])('does not re-offer an answered consultation: %j', (answer) => {
    expect(
      consultationPending(
        {
          choice: 'not_now',
          level: 'l2',
          offerCount: 1,
          followUpAt: new Date(0),
          ...answer,
        },
        new Date(),
      ),
    ).toBe(false);
  });
});

describe('event publisher configuration', () => {
  afterEach(() => vi.restoreAllMocks());
  it('requires a production project and fails explicitly when local publishing is unconfigured', async () => {
    expect(() => createEventPublisher({ NODE_ENV: 'production' })).toThrow('GCP_PROJECT_ID');
    const publish = createEventPublisher({ NODE_ENV: 'development' });
    await expect(
      publish('checkin.created', { childId: 'child', kind: 'mood', checkinId: 'checkin' }),
    ).rejects.toThrow('checkin_publisher_not_configured');
  });
  it('wires production publication to PubSubRestPublisher.fromEnv', async () => {
    const request = vi.fn(async () => ({}));
    const publisher = new PubSubRestPublisher('test-project', { request } as GoogleHttp);
    const factory = vi.spyOn(PubSubRestPublisher, 'fromEnv').mockReturnValue(publisher);
    const publish = createEventPublisher({
      NODE_ENV: 'production',
      GCP_PROJECT_ID: 'test-project',
    });
    await publish('checkin.created', { childId: 'child', kind: 'mood', checkinId: 'checkin' });
    expect(factory).toHaveBeenCalledWith('test-project', {});
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://pubsub.googleapis.com/v1/projects/test-project/topics/checkin-created:publish',
      }),
    );
  });
});
