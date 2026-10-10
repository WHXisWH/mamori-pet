import { describe, expect, it } from 'vitest';

import { hiddenPetUnlocked } from './routes/child-profile.js';

describe('hidden pet unlock', () => {
  it('unlocks at the second island stage', () => {
    expect(hiddenPetUnlocked(2)).toBe(false);
    expect(hiddenPetUnlocked(3)).toBe(true);
  });
});
