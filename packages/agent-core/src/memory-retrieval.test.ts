import { describe, expect, it } from 'vitest';

import { rankMemories } from './memory-retrieval.js';

describe('local semantic memory fallback', () => {
  it('recalls related Japanese wording and keeps the newest relevant item first', () => {
    const result = rankMemories('学校で無視された', [
      { text: '教室で仲間外れにされた', createdAt: new Date('2026-10-02') },
      { text: '家でゲームをした', createdAt: new Date('2026-10-05') },
      { text: '先生に相談した', createdAt: new Date('2026-10-04') },
    ]);
    expect(result.map((item) => item.text)).toEqual(['教室で仲間外れにされた', '先生に相談した']);
  });

  it('does not return unrelated or empty queries', () => {
    expect(rankMemories('   ', [{ text: '学校のこと' }])).toEqual([]);
    expect(rankMemories('水泳', [{ text: '学校のこと' }])).toEqual([]);
  });
});
