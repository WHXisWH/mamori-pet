import { describe, expect, it } from 'vitest';

import { initialMoodFlow, moodExpression, moodFlow, type MoodFlow } from './mood-flow';

describe('mood flow', () => {
  it('starts fresh unless today is already recorded', () => {
    expect(initialMoodFlow(null, '2026-10-02')).toEqual({ step: 'choosing' });
    expect(initialMoodFlow({ date: '2026-10-01', weather: 'rainy' }, '2026-10-02')).toEqual({
      step: 'choosing',
    });
    expect(initialMoodFlow({ date: '2026-10-02', weather: 'rainy' }, '2026-10-02')).toEqual({
      step: 'done',
      weather: 'rainy',
    });
  });

  it('lets the child change the pick freely before confirming', () => {
    let s: MoodFlow = { step: 'choosing' };
    s = moodFlow(s, { type: 'pick', weather: 'sunny' });
    s = moodFlow(s, { type: 'pick', weather: 'stormy' });
    expect(s).toEqual({ step: 'picked', weather: 'stormy' });
  });

  it('records only on confirm, and only once while sending', () => {
    expect(moodFlow({ step: 'choosing' }, { type: 'confirm' })).toEqual({ step: 'choosing' });
    const sending = moodFlow({ step: 'picked', weather: 'rainy' }, { type: 'confirm' });
    expect(sending).toEqual({ step: 'sending', weather: 'rainy' });
    expect(moodFlow(sending, { type: 'pick', weather: 'sunny' })).toBe(sending);
    expect(moodFlow(sending, { type: 'confirm' })).toBe(sending);
    expect(moodFlow(sending, { type: 'sent', reply: 'ok' })).toEqual({
      step: 'done',
      weather: 'rainy',
      reply: 'ok',
    });
  });

  it('keeps the pick when sending fails so the child can retry', () => {
    expect(moodFlow({ step: 'sending', weather: 'cloudy' }, { type: 'failed' })).toEqual({
      step: 'picked',
      weather: 'cloudy',
    });
  });

  it('can choose again after recording', () => {
    expect(moodFlow({ step: 'done', weather: 'sunny' }, { type: 'again' })).toEqual({
      step: 'choosing',
    });
    expect(
      moodFlow({ step: 'done', weather: 'sunny' }, { type: 'pick', weather: 'rainy' }),
    ).toEqual({ step: 'done', weather: 'sunny' });
  });

  it('never celebrates rain or thunder', () => {
    for (const weather of ['rainy', 'stormy'] as const) {
      expect(moodExpression({ step: 'picked', weather })).toBe('caring');
      expect(moodExpression({ step: 'done', weather })).toBe('caring');
    }
    expect(moodExpression({ step: 'done', weather: 'sunny' })).toBe('celebrate');
  });
});
