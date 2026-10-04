import { describe, expect, it } from 'vitest';
import { resolveModelId } from './model.js';

describe('explicit model routes', () => {
  it('rejects missing and floating model aliases', () => {
    expect(() => resolveModelId('petChat', {})).toThrow('GEMINI_MODEL_PET_CHAT');
    expect(() =>
      resolveModelId('petChat', { GEMINI_MODEL_PET_CHAT: 'gemini-flash-latest' }),
    ).toThrow();
    expect(() => resolveModelId('petChat', { GEMINI_MODEL_PET_CHAT: '../model' })).toThrow();
  });
  it('keeps independently configured purposes', () => {
    expect(resolveModelId('crisisReview', { GEMINI_MODEL_CRISIS_REVIEW: 'gemini-test-001' })).toBe(
      'gemini-test-001',
    );
  });
});
