import type { Lexicon } from '@ijime/kb-loader';
import { describe, expect, it } from 'vitest';

import { KeywordMatcher } from './keyword.js';

const LEXICON: Lexicon = {
  language: 'ja',
  categories: [
    { id: 'avoidance', label_ja: '話題回避', handling: 'domain_a', expressions: ['別に', '普通'] },
    {
      id: 'crisis',
      label_ja: '危機',
      handling: 'l4_review',
      expressions: ['死にたい', '消えたい', 'いなくなりたい', 'しにたい'],
    },
  ],
};

describe('KeywordMatcher', () => {
  const m = KeywordMatcher.fromLexicon(LEXICON);

  it('matches exact expressions', () => {
    expect(m.match('もう死にたい')).toEqual({ hit: true, matched: ['死にたい'] });
  });

  it('matches across kana, width, spacing and repeats', () => {
    expect(m.match('シニタイ').hit).toBe(true);
    expect(m.match('し に た い').hit).toBe(true);
    expect(m.match('しにたいいいい').hit).toBe(true);
    expect(m.match('消え\u3000たい…').hit).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(m.match('きょうは たのしかった')).toEqual({ hit: false, matched: [] });
    expect(m.match('死ぬほど笑った').hit).toBe(false);
  });

  it('only uses the crisis category', () => {
    expect(m.match('別に').hit).toBe(false);
  });

  it('dedupes expressions that normalize identically', () => {
    const dup = new KeywordMatcher(['シニタイ', 'しにたい', 'し に た い']);
    expect(dup.match('しにたい').matched).toEqual(['シニタイ']);
    expect(m.match('しにたい').matched).toEqual(['しにたい']);
  });

  it('fails fast on a bad lexicon', () => {
    expect(() => KeywordMatcher.fromLexicon({ language: 'ja', categories: [] })).toThrow(/crisis/);
    expect(() => new KeywordMatcher(['', '  '])).toThrow(/at least one/);
  });
});
