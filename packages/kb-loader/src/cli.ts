#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isConversationContent, validateConversationContent } from './content.js';
import { buildManifest, Kb, MANIFEST_PATH } from './kb.js';
import { verifyReviewSignatures } from './review.js';
import { manifestSchema, type Manifest } from './schemas.js';
import { FsKbSource, type KbSource } from './source.js';
import { SOURCE_REGISTRY_PATH, validateKnowledgeBase } from './validate.js';

function candidate(source: KbSource, manifest: Manifest): { json: string; kb: Promise<Kb> } {
  const json = JSON.stringify(manifest, null, 2) + '\n';
  const kb = Kb.load({
    list: () => source.list(),
    read: (path) =>
      path === MANIFEST_PATH ? Promise.resolve(Buffer.from(json)) : source.read(path),
  });
  return { json, kb };
}

export async function runManifestCli(argv: string[]): Promise<number> {
  const dir = argv[0];
  if (!dir) {
    process.stderr.write('usage: kb-manifest <kb/vX.Y.Z dir> [--check] [--release]\n');
    return 2;
  }
  const release = argv.includes('--release');
  const check = argv.includes('--check');
  const version = basename(dir).replace(/^v/, '');
  const manifestFile = join(dir, MANIFEST_PATH);
  type Meta = Partial<Pick<Manifest, 'releasedAt' | 'approvedBy' | 'reviewStatus'>>;
  const existing: Meta = await readFile(manifestFile, 'utf8')
    .then((s) => JSON.parse(s) as Meta)
    .catch((): Meta => ({}));
  const source = new FsKbSource(dir);
  let manifest = await buildManifest(source, {
    version,
    releasedAt: existing.releasedAt ?? new Date().toISOString(),
    approvedBy: existing.approvedBy ?? [],
    ...(existing.reviewStatus ? { reviewStatus: existing.reviewStatus } : {}),
  });
  if (release) {
    const verified = await verifyReviewSignatures(await candidate(source, manifest).kb);
    manifest = manifestSchema.parse({
      ...manifest,
      approvedBy: verified.reviewers,
      reviewStatus: 'expert_approved',
    });
  }
  const { json: next, kb: loading } = candidate(source, manifest);
  // Validate the candidate before writing so a bad draft cannot refresh its checksums.
  const kb = await loading;
  if (release || kb.paths().some(isConversationContent)) {
    await validateConversationContent(kb, { release });
  }
  if (kb.has(SOURCE_REGISTRY_PATH) || kb.paths('signals/').length > 0) {
    await validateKnowledgeBase(kb);
  }
  if (check) {
    const current = await readFile(manifestFile, 'utf8').catch(() => '');
    if (current !== next) {
      process.stderr.write(`${manifestFile} is out of date; run kb-manifest ${dir}\n`);
      return 1;
    }
    return 0;
  }
  await writeFile(manifestFile, next);
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runManifestCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
