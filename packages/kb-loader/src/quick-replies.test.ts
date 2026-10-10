import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { Kb } from './kb.js';
import { FsKbSource } from './source.js';
import {
  loadQuickReplyCatalog,
  quickReplyCatalogSchema,
  QUICK_REPLY_INTENTS,
} from './quick-replies.js';

const catalog = await loadQuickReplyCatalog(
  await Kb.load(new FsKbSource(fileURLToPath(new URL('../../../kb/v0.1.0', import.meta.url)))),
);

describe('versioned quick reply catalog', () => {
  it.each(['low', 'high', 'jhs'] as const)(
    'contains distinct bounded child utterances for %s',
    (grade) => {
      expect(Object.keys(catalog[grade])).toEqual([...QUICK_REPLY_INTENTS]);
      expect(new Set(Object.values(catalog[grade])).size).toBe(6);
      for (const label of Object.values(catalog[grade])) {
        expect(label.length).toBeGreaterThan(0);
        expect(label.length).toBeLessThanOrEqual(30);
        expect(label).not.toMatch(/あげる|大丈夫だよ|だいじょうぶだよ|あそぶ|遊ぶ/);
      }
    },
  );

  it('rejects a missing grade, missing intent, duplicate label, empty or oversized label', () => {
    const missingGrade = { low: catalog.low, high: catalog.high };
    const missingIntent = Object.fromEntries(
      Object.entries(catalog.low).filter(([key]) => key !== 'pause'),
    );
    for (const candidate of [
      missingGrade,
      { ...catalog, low: missingIntent },
      { ...catalog, low: { ...catalog.low, pause: catalog.low.listen_only } },
      { ...catalog, low: { ...catalog.low, pause: ' ' } },
      { ...catalog, low: { ...catalog.low, pause: 'あ'.repeat(31) } },
    ])
      expect(quickReplyCatalogSchema.safeParse(candidate).success).toBe(false);
  });
});
