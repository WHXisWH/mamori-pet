import type { Lexicon } from '@ijime/kb-loader';

import { normalizeJa } from './normalize.js';

export const CRISIS_CATEGORY_ID = 'crisis';

export type KeywordMatch = { hit: boolean; matched: string[] };

export class KeywordMatcher {
  private readonly patterns: { raw: string; normalized: string }[];

  constructor(expressions: readonly string[]) {
    const seen = new Set<string>();
    this.patterns = [];
    for (const raw of expressions) {
      const normalized = normalizeJa(raw);
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      this.patterns.push({ raw, normalized });
    }
    if (this.patterns.length === 0)
      throw new Error('keyword matcher needs at least one expression');
  }

  static fromLexicon(lexicon: Lexicon, categoryId = CRISIS_CATEGORY_ID): KeywordMatcher {
    const category = lexicon.categories.find((c) => c.id === categoryId);
    if (!category) throw new Error(`lexicon has no category ${categoryId}`);
    return new KeywordMatcher(category.expressions);
  }

  match(text: string): KeywordMatch {
    const normalized = normalizeJa(text);
    const matched = this.patterns
      .filter((p) => normalized.includes(p.normalized))
      .map((p) => p.raw);
    return { hit: matched.length > 0, matched };
  }
}
