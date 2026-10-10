import { describe, expect, it } from 'vitest';

import { buildSafeAgentSummary } from './summary.js';

describe('agent summary', () => {
  it('stores only coarse allowlisted topics instead of quoting a child', () => {
    const secret = '学校で言われた秘密の文章';
    const summary = buildSafeAgentSummary([{ role: 'child', text: secret }]);
    expect(summary).toBe('最近は 学校のこと の 話を している。');
    expect(summary).not.toContain(secret);
  });

  it('returns an empty summary when there is no child text', () => {
    expect(buildSafeAgentSummary([{ role: 'pet', text: 'うん。' }])).toBe('');
  });
});
