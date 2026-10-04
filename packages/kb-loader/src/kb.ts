import { createHash } from 'node:crypto';

import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';

import { type Manifest, manifestSchema } from './schemas.js';
import type { KbSource } from './source.js';

export const MANIFEST_PATH = 'manifest.json';

export class KbIntegrityError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = 'KbIntegrityError';
  }
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export class Kb {
  private readonly cache = new Map<string, Buffer>();

  private constructor(
    readonly manifest: Manifest,
    private readonly source: KbSource,
  ) {}

  get version(): string {
    return this.manifest.version;
  }

  static async load(source: KbSource): Promise<Kb> {
    const manifestRaw = await source.read(MANIFEST_PATH);
    const parsed = manifestSchema.safeParse(JSON.parse(manifestRaw.toString('utf8')));
    if (!parsed.success) {
      throw new KbIntegrityError(`invalid manifest: ${parsed.error.message}`, MANIFEST_PATH);
    }
    const kb = new Kb(parsed.data, source);
    await kb.verifyAll();
    return kb;
  }

  has(path: string): boolean {
    return path in this.manifest.files;
  }

  paths(prefix = ''): string[] {
    return Object.keys(this.manifest.files)
      .filter((p) => p.startsWith(prefix))
      .sort();
  }

  async bytes(path: string): Promise<Buffer> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const expected = this.manifest.files[path];
    if (!expected) throw new KbIntegrityError(`file not in manifest: ${path}`, path);
    const buf = await this.source.read(path);
    const actual = sha256(buf);
    if (actual !== expected) {
      throw new KbIntegrityError(`checksum mismatch for ${path}`, path);
    }
    this.cache.set(path, buf);
    return buf;
  }

  async text(path: string): Promise<string> {
    return (await this.bytes(path)).toString('utf8');
  }

  async yaml<T>(path: string, schema: ZodType<T>): Promise<T> {
    const raw: unknown = parseYaml(await this.text(path));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new KbIntegrityError(`schema violation in ${path}: ${parsed.error.message}`, path);
    }
    return parsed.data;
  }

  private async verifyAll(): Promise<void> {
    const listed = new Set(await this.source.list());
    listed.delete(MANIFEST_PATH);
    const declared = new Set(Object.keys(this.manifest.files));
    for (const p of declared) {
      if (!listed.has(p)) throw new KbIntegrityError(`declared but missing: ${p}`, p);
    }
    for (const p of listed) {
      if (!declared.has(p)) throw new KbIntegrityError(`present but not in manifest: ${p}`, p);
    }
    await Promise.all([...declared].map((p) => this.bytes(p)));
  }
}

export async function buildManifest(
  source: KbSource,
  meta: Pick<Manifest, 'version' | 'releasedAt' | 'approvedBy' | 'reviewStatus'>,
): Promise<Manifest> {
  const files: Record<string, string> = {};
  for (const p of await source.list()) {
    if (p === MANIFEST_PATH) continue;
    files[p] = sha256(await source.read(p));
  }
  return manifestSchema.parse({ ...meta, files });
}
