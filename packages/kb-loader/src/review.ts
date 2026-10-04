import { createHash } from 'node:crypto';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { KbIntegrityError, type Kb } from './kb.js';
import type { Manifest } from './schemas.js';

export const REVIEW_DIR = 'review/';
export const REVIEW_DRAFT_STATUS = 'DRAFT';

const isoDate = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export const reviewSignatureSchema = z.strictObject({
  status: z.enum(['signed', REVIEW_DRAFT_STATUS]).default('signed'),
  reviewer: z.string().trim().min(1),
  qualification: z.string().trim().min(1),
  scope: z.array(z.string().trim().min(1)).min(1),
  reviewed_at: z.preprocess(
    (value) => (value instanceof Date ? value.toISOString() : value),
    z.string().regex(isoDate),
  ),
  manifest_hash: z.string().regex(/^[0-9a-f]{64}$/),
  signature_note: z.string().trim().min(1),
});
export type ReviewSignature = z.infer<typeof reviewSignatureSchema>;

export type ReviewVerification = {
  manifestHash: string;
  reviewers: string[];
  signatures: { path: string; signature: ReviewSignature }[];
};

function fail(message: string, path?: string): never {
  throw new KbIntegrityError(`expert review: ${message}; not releasable`, path);
}

export function isReviewSignature(path: string): boolean {
  return /^review\/[^/]+\.ya?ml$/.test(path);
}

export function reviewableFiles(files: Manifest['files']): string[] {
  return Object.keys(files)
    .filter((path) => !isReviewSignature(path))
    .sort();
}

export function manifestHash(files: Manifest['files']): string {
  const entries = reviewableFiles(files).map((path) => [path, files[path]]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          pattern += '(?:.*/)?';
        } else pattern += '.*';
      } else pattern += '[^/]*';
    } else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesScope(scope: readonly string[], path: string): boolean {
  return scope.some((glob) => globToRegExp(glob).test(path));
}

export async function readReviewSignatures(
  kb: Pick<Kb, 'paths' | 'text'>,
): Promise<{ path: string; signature: ReviewSignature }[]> {
  const out: { path: string; signature: ReviewSignature }[] = [];
  for (const path of kb.paths(REVIEW_DIR).filter(isReviewSignature)) {
    const parsed = reviewSignatureSchema.safeParse(parseYaml(await kb.text(path)));
    if (!parsed.success) fail(`invalid signature file ${path}`, path);
    out.push({ path, signature: parsed.data });
  }
  return out;
}

export async function verifyReviewSignatures(
  kb: Pick<Kb, 'paths' | 'text' | 'manifest'>,
): Promise<ReviewVerification> {
  const all = await readReviewSignatures(kb);
  const signatures = all.filter(({ signature }) => signature.status === 'signed');
  if (signatures.length === 0) fail('no signed expert review');
  const hash = manifestHash(kb.manifest.files);
  for (const { path, signature } of signatures) {
    if (signature.manifest_hash !== hash) fail(`${path} signs a different manifest`, path);
  }
  const uncovered = reviewableFiles(kb.manifest.files).filter(
    (path) => !signatures.some(({ signature }) => matchesScope(signature.scope, path)),
  );
  if (uncovered.length > 0) fail(`files without signature: ${uncovered.join(', ')}`);
  const reviewers = [...new Set(signatures.map(({ signature }) => signature.reviewer.trim()))];
  return { manifestHash: hash, reviewers, signatures };
}
