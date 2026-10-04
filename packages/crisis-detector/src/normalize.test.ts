import { describe, expect, it } from 'vitest';

import { katakanaToHiragana, normalizeJa } from './normalize.js';

describe('normalizeJa', () => {
  it('unifies katakana and hiragana', () => {
    expect(katakanaToHiragana('シニタイ')).toBe('しにたい');
    expect(normalizeJa('シニタイ')).toBe(normalizeJa('しにたい'));
  });

  it('unifies full-width and half-width forms', () => {
    expect(normalizeJa('ＡＢＣ１２３')).toBe('abc123');
    expect(normalizeJa('ｼﾆﾀｲ')).toBe('しにたい');
  });

  it('removes spaces and punctuation', () => {
    expect(normalizeJa('死に たい 。。。')).toBe('死にたい');
    expect(normalizeJa('しにたい！！？')).toBe('しにたい');
    expect(normalizeJa('消え\u3000たい')).toBe('消えたい');
  });

  it('collapses repeated characters to at most two', () => {
    expect(normalizeJa('しにたいいいいい')).toBe('しにたいい');
    expect(normalizeJa('きょうも')).toBe('きょうも');
  });

  it('drops long vowel marks', () => {
    expect(normalizeJa('しにたーい')).toBe('しにたい');
  });

  it('keeps kanji as-is', () => {
    expect(normalizeJa('死ぬほど笑った')).toBe('死ぬほど笑った');
  });
});
