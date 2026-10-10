// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { safeRepliesSchema } from '@ijime/kb-loader';
import { parse } from 'yaml';

import restCopy from '@/generated/rest_reminders.json';

import { restRhythm } from './rest-rhythm';

describe('JST rest rhythm', () => {
  it('uses the same validated per-grade KB replies as the backend', () => {
    const source = parse(
      readFileSync(
        new URL('../../../../kb/v0.1.0/prompts/rest-reminders.yaml', import.meta.url),
        'utf8',
      ),
    );
    expect(safeRepliesSchema.parse(source)).toEqual(restCopy);
    expect(restCopy.replies.low).not.toMatch(/\p{Script=Han}/u);
  });

  it.each([
    ['2026-10-06T22:59:59.999+09:00', false, 1],
    ['2026-10-06T23:00:00+09:00', true, 6 * 3_600_000],
    ['2026-10-07T00:00:00+09:00', true, 5 * 3_600_000],
    ['2026-10-07T04:59:59.999+09:00', true, 1],
    ['2026-10-07T05:00:00+09:00', false, 18 * 3_600_000],
    ['2026-12-31T23:00:00+09:00', true, 6 * 3_600_000],
    ['2028-02-29T23:00:00+09:00', true, 6 * 3_600_000],
    ['2026-10-06T10:00:00-04:00', true, 6 * 3_600_000],
  ])('%s has the correct state and next boundary', (instant, night, nextChangeMs) => {
    expect(restRhythm(new Date(instant))).toEqual({ night, nextChangeMs });
  });
});
