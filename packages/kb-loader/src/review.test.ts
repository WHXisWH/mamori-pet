import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';

import { KbIntegrityError } from './kb.js';
import {
  globToRegExp,
  manifestHash,
  matchesScope,
  reviewableFiles,
  verifyReviewSignatures,
} from './review.js';

const files = {
  'skills/a.md': 'a'.repeat(64),
  'prompts/charter.md': 'b'.repeat(64),
};

function fixture(signatures: Record<string, unknown>) {
  const texts = new Map(
    Object.entries(signatures).map(([path, body]) => [path, stringify(body)] as const),
  );
  const all: Record<string, string> = { ...files };
  for (const path of texts.keys()) all[path] = 'e'.repeat(64);
  return {
    manifest: { files: all },
    paths: (prefix = '') =>
      Object.keys(all)
        .filter((p) => p.startsWith(prefix))
        .sort(),
    text: async (path: string) => texts.get(path) ?? '',
  } as never;
}

const signed = (overrides: Record<string, unknown> = {}) => ({
  reviewer: '佐藤',
  qualification: '公認心理師',
  scope: ['**'],
  reviewed_at: '2026-10-03',
  manifest_hash: manifestHash(files),
  signature_note: '全文確認',
  ...overrides,
});

describe('review signatures', () => {
  it('hashes only non-signature files, so the hash is stable while signatures are added', () => {
    const withSignatures = { ...files, 'review/dr-sato.yaml': 'c'.repeat(64) };
    expect(reviewableFiles(withSignatures)).toEqual(['prompts/charter.md', 'skills/a.md']);
    expect(manifestHash(withSignatures)).toBe(manifestHash(files));
    expect(manifestHash(files)).not.toBe(manifestHash({ ...files, 'skills/a.md': 'f'.repeat(64) }));
  });

  it('matches globs per path segment', () => {
    expect(globToRegExp('skills/*.md').test('skills/a.md')).toBe(true);
    expect(globToRegExp('skills/*.md').test('skills/sub/a.md')).toBe(false);
    expect(globToRegExp('skills/**').test('skills/sub/a.md')).toBe(true);
    expect(globToRegExp('**/*.yaml').test('rules/a.yaml')).toBe(true);
    expect(globToRegExp('**/*.yaml').test('a.yaml')).toBe(true);
    expect(globToRegExp('prompts/persona/?.md').test('prompts/persona/ab.md')).toBe(false);
    expect(matchesScope(['skills/*.md', 'prompts/**'], 'prompts/grade/low.md')).toBe(true);
    expect(matchesScope(['skills/*.md'], 'prompts/charter.md')).toBe(false);
  });

  it('accepts signatures that match the hash and jointly cover every file', async () => {
    const result = await verifyReviewSignatures(
      fixture({
        'review/example.yaml': signed({ status: 'DRAFT', manifest_hash: '0'.repeat(64) }),
        'review/dr-sato.yaml': signed({ scope: ['skills/**'] }),
        'review/dr-ito.yaml': signed({ reviewer: '伊藤', scope: ['prompts/*.md'] }),
      }),
    );
    expect(result.reviewers).toEqual(['伊藤', '佐藤']);
    expect(result.signatures.map((s) => s.path)).toEqual([
      'review/dr-ito.yaml',
      'review/dr-sato.yaml',
    ]);
    expect(result.manifestHash).toBe(manifestHash(files));
  });

  it('ignores drafts and rejects when no signed review exists', async () => {
    await expect(
      verifyReviewSignatures(fixture({ 'review/example.yaml': signed({ status: 'DRAFT' }) })),
    ).rejects.toThrow(/no signed expert review; not releasable/);
    await expect(verifyReviewSignatures(fixture({}))).rejects.toThrow(KbIntegrityError);
  });

  it('rejects a signature over a different manifest', async () => {
    await expect(
      verifyReviewSignatures(
        fixture({ 'review/dr-sato.yaml': signed({ manifest_hash: '1'.repeat(64) }) }),
      ),
    ).rejects.toThrow(/signs a different manifest/);
  });

  it('rejects when signed scopes leave a file uncovered', async () => {
    await expect(
      verifyReviewSignatures(fixture({ 'review/dr-sato.yaml': signed({ scope: ['skills/**'] }) })),
    ).rejects.toThrow(/files without signature: prompts\/charter.md/);
  });

  it('rejects malformed, incomplete or unknown-field signatures', async () => {
    for (const bad of [
      signed({ reviewer: ' ' }),
      signed({ scope: [] }),
      signed({ manifest_hash: 'xyz' }),
      signed({ reviewed_at: 'yesterday' }),
      signed({ extra: true }),
      { reviewer: '佐藤' },
    ]) {
      await expect(verifyReviewSignatures(fixture({ 'review/dr-sato.yaml': bad }))).rejects.toThrow(
        /invalid signature file review\/dr-sato.yaml/,
      );
    }
  });
});
