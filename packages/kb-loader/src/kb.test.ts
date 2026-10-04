import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildManifest, Kb, KbIntegrityError, MANIFEST_PATH } from './kb.js';
import { lexiconSchema } from './schemas.js';
import { FsKbSource, GcsKbSource } from './source.js';

const LEXICON = `language: ja
categories:
  - id: crisis
    label_ja: 危機
    handling: l4_review
    expressions: ["死にたい", "消えたい"]
`;

describe('Kb', () => {
  let dir: string;
  let source: FsKbSource;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kb-'));
    await mkdir(join(dir, 'lexicon'), { recursive: true });
    await mkdir(join(dir, 'prompts'), { recursive: true });
    await writeFile(join(dir, 'lexicon', 'ja.yaml'), LEXICON);
    await writeFile(join(dir, 'prompts', 'charter.md'), '# 守り手の約束\n');
    source = new FsKbSource(dir);
    const manifest = await buildManifest(source, {
      version: '0.1.0',
      releasedAt: '2026-09-29T00:00:00.000Z',
      approvedBy: [],
    });
    await writeFile(join(dir, MANIFEST_PATH), JSON.stringify(manifest));
  });

  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('loads and verifies every declared file', async () => {
    const kb = await Kb.load(source);
    expect(kb.version).toBe('0.1.0');
    expect(kb.paths('prompts/')).toEqual(['prompts/charter.md']);
    expect(await kb.text('prompts/charter.md')).toContain('守り手');
    const lex = await kb.yaml('lexicon/ja.yaml', lexiconSchema);
    expect(lex.categories[0]?.expressions).toContain('死にたい');
  });

  it('rejects a tampered file', async () => {
    await writeFile(join(dir, 'prompts', 'charter.md'), '# changed\n');
    await expect(Kb.load(source)).rejects.toThrow(KbIntegrityError);
    await expect(Kb.load(source)).rejects.toThrow(/checksum mismatch/);
  });

  it('rejects an undeclared file', async () => {
    await writeFile(join(dir, 'prompts', 'extra.md'), 'x');
    await expect(Kb.load(source)).rejects.toThrow(/not in manifest/);
  });

  it('rejects a missing file', async () => {
    await rm(join(dir, 'prompts', 'charter.md'));
    await expect(Kb.load(source)).rejects.toThrow(/declared but missing/);
  });

  it('rejects an invalid manifest', async () => {
    await writeFile(join(dir, MANIFEST_PATH), JSON.stringify({ version: 'x' }));
    await expect(Kb.load(source)).rejects.toThrow(/invalid manifest/);
  });

  it('reports schema violations by path', async () => {
    const kb = await Kb.load(source);
    await expect(kb.yaml('lexicon/ja.yaml', z.object({ nope: z.string() }))).rejects.toThrow(
      /schema violation in lexicon\/ja.yaml/,
    );
    await expect(kb.bytes('missing.md')).rejects.toThrow(/not in manifest/);
  });
});

describe('GcsKbSource', () => {
  it('strips the prefix and downloads by full name', async () => {
    const files = new Map<string, Buffer>([
      ['kb/v0.1.0/manifest.json', Buffer.from('{}')],
      ['kb/v0.1.0/prompts/charter.md', Buffer.from('c')],
      ['kb/v0.1.0/prompts/', Buffer.alloc(0)],
    ]);
    const bucket = {
      async getFiles({ prefix }: { prefix: string }) {
        return [
          [...files.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        ] as [{ name: string }[]];
      },
      file(name: string) {
        return {
          async download() {
            const b = files.get(name);
            if (!b) throw new Error(`no such object ${name}`);
            return [b] as [Buffer];
          },
        };
      },
    };
    const src = new GcsKbSource(bucket, 'kb/v0.1.0/');
    expect(await src.list()).toEqual(['manifest.json', 'prompts/charter.md']);
    expect((await src.read('prompts/charter.md')).toString()).toBe('c');
  });
});
