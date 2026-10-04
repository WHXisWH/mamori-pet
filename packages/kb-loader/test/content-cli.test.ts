import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runManifestCli } from '../src/cli.js';
import { DRAFT_MARKER, isConversationContent, LITERATURE_MARKER } from '../src/content.js';
import { buildManifest } from '../src/kb.js';
import { manifestHash } from '../src/review.js';
import { FsKbSource } from '../src/source.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = new FsKbSource(resolve(here, '../../../kb/v0.1.0'));
const REVIEW_STATUS_LINE = /^review_status: .+$/m;

describe('supported manifest CLI content checks', () => {
  let temp: string;
  let dir: string;
  beforeEach(async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    temp = await mkdtemp(join(tmpdir(), 'ijime-content-'));
    dir = join(temp, 'v0.1.0');
    for (const path of await source.list()) {
      const target = join(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await source.read(path));
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temp, { recursive: true, force: true });
  });

  async function setReviewStatus(status: string) {
    const review = join(dir, 'content-review.yaml');
    await writeFile(
      review,
      (await readFile(review, 'utf8')).replace(REVIEW_STATUS_LINE, `review_status: ${status}`),
    );
  }

  async function relabelContent(marker: string) {
    const copy = new FsKbSource(dir);
    for (const path of (await copy.list()).filter(isConversationContent)) {
      const text = (await copy.read(path)).toString('utf8');
      await writeFile(join(dir, path), text.replaceAll(LITERATURE_MARKER, marker));
    }
  }

  // The real KB is past the draft stage, so the draft case is rebuilt inside the copy.
  async function draftFixture() {
    await relabelContent(DRAFT_MARKER);
    await setReviewStatus('draft_pending_expert_review');
    const file = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(
      file,
      JSON.stringify({ ...manifest, reviewStatus: 'draft_pending_expert_review' }),
    );
  }

  it('preserves the explicit draft status and empty approval when regenerating hashes', async () => {
    // Arrange
    await draftFixture();

    // Act
    const written = await runManifestCli([dir]);

    // Assert
    expect(written).toBe(0);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      reviewStatus: string;
      approvedBy: string[];
    };
    expect(manifest.reviewStatus).toBe('draft_pending_expert_review');
    expect(manifest.approvedBy).toEqual([]);
    expect(await runManifestCli([dir, '--check'])).toBe(0);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('rejects a draft release without writing or inventing expert approval', async () => {
    // Arrange
    await draftFixture();
    expect(await runManifestCli([dir])).toBe(0);
    const manifest = await readFile(join(dir, 'manifest.json'), 'utf8');

    // Act
    const released = runManifestCli([dir, '--check', '--release']);

    // Assert
    await expect(released).rejects.toThrow('not releasable');
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  it('preserves the literature-reviewed status and empty approval when regenerating hashes', async () => {
    const path = join(dir, 'skills/daily-listening.md');
    await writeFile(path, `${await readFile(path, 'utf8')}\n`);
    expect(await runManifestCli([dir])).toBe(0);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      reviewStatus: string;
      approvedBy: string[];
    };
    expect(manifest.reviewStatus).toBe('literature_reviewed');
    expect(manifest.approvedBy).toEqual([]);
    expect(await runManifestCli([dir, '--check'])).toBe(0);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('reports stale hashes without changing the manifest', async () => {
    const manifest = await readFile(join(dir, 'manifest.json'), 'utf8');
    const path = join(dir, 'prompts/persona/moko.md');
    await writeFile(path, `${await readFile(path, 'utf8')}\n`);
    expect(await runManifestCli([dir, '--check'])).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('out of date'));
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  it('does not regenerate checksums for a placeholder reintroduced in runtime content', async () => {
    const manifest = await readFile(join(dir, 'manifest.json'), 'utf8');
    const path = join(dir, 'prompts/persona/moko.md');
    await writeFile(path, `${await readFile(path, 'utf8')}\nTODO\n`);
    await expect(runManifestCli([dir])).rejects.toThrow('placeholder content');
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  it('rejects a literature-reviewed release without writing or inventing expert approval', async () => {
    const manifest = await readFile(join(dir, 'manifest.json'), 'utf8');
    expect((JSON.parse(manifest) as { reviewStatus: string }).reviewStatus).toBe(
      'literature_reviewed',
    );
    await expect(runManifestCli([dir, '--check', '--release'])).rejects.toThrow('not releasable');
    await expect(runManifestCli([dir, '--release'])).rejects.toThrow('no signed expert review');
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  it('does not refresh checksums for literature-reviewed content relabelled as a draft body', async () => {
    // Arrange
    const manifest = await readFile(join(dir, 'manifest.json'), 'utf8');
    const path = join(dir, 'skills/bedtime.md');
    await writeFile(path, `${await readFile(path, 'utf8')}\n${DRAFT_MARKER}\n`);

    // Act
    const written = runManifestCli([dir]);

    // Assert
    await expect(written).rejects.toThrow('draft body cannot be marked literature reviewed');
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  async function approvedFixture(reviewer = 'synthetic-reviewer') {
    const copy = new FsKbSource(dir);
    await relabelContent('専門家レビュー済み');
    await setReviewStatus('expert_approved');
    const { files } = await buildManifest(copy, {
      version: '0.1.0',
      releasedAt: '2026-10-03T00:00:00.000Z',
      approvedBy: [],
    });
    await writeFile(
      join(dir, 'review/synthetic.yaml'),
      [
        `reviewer: ${reviewer}`,
        'qualification: synthetic-test-only',
        "scope: ['**']",
        "reviewed_at: '2026-10-03'",
        `manifest_hash: '${manifestHash(files)}'`,
        'signature_note: synthetic fixture, not a real review',
        '',
      ].join('\n'),
    );
  }

  it('writes approval from verified signatures on --release and keeps --check --release green', async () => {
    await approvedFixture();
    expect(await runManifestCli([dir, '--release'])).toBe(0);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
      reviewStatus: string;
      approvedBy: string[];
      files: Record<string, string>;
    };
    expect(manifest.reviewStatus).toBe('expert_approved');
    expect(manifest.approvedBy).toEqual(['synthetic-reviewer']);
    expect(manifest.files).toHaveProperty(['review/synthetic.yaml']);
    expect(await runManifestCli([dir, '--check', '--release'])).toBe(0);
    expect(process.stderr.write).not.toHaveBeenCalled();
  });

  it('rejects release once signed content changes, without touching the manifest', async () => {
    await approvedFixture();
    expect(await runManifestCli([dir, '--release'])).toBe(0);
    const manifest = await readFile(join(dir, 'manifest.json'), 'utf8');
    const path = join(dir, 'skills/bedtime.md');
    await writeFile(path, `${await readFile(path, 'utf8')}\n`);
    await expect(runManifestCli([dir, '--check', '--release'])).rejects.toThrow(
      'signs a different manifest',
    );
    await expect(runManifestCli([dir, '--release'])).rejects.toThrow('not releasable');
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(manifest);
  });

  it('rejects release when the signed scope does not cover every file', async () => {
    await approvedFixture();
    const signature = join(dir, 'review/synthetic.yaml');
    await writeFile(
      signature,
      (await readFile(signature, 'utf8')).replace("scope: ['**']", "scope: ['skills/**']"),
    );
    await expect(runManifestCli([dir, '--release'])).rejects.toThrow('files without signature');
  });

  it('does not count the bundled DRAFT example as a signature', async () => {
    await expect(runManifestCli([dir, '--release'])).rejects.toThrow('no signed expert review');
  });
});
