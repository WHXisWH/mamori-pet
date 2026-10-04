import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { CHARACTER_IDS, GRADE_BANDS } from '@ijime/api-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { CONTENT_REVIEW_PATH, validateConversationContent } from '../src/content.js';
import { buildManifest, Kb, MANIFEST_PATH } from '../src/kb.js';
import { manifestSchema, signalDefinitionSchema } from '../src/schemas.js';
import { FsKbSource, type KbSource } from '../src/source.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const repo = resolve(root, '../..');

type Review = Awaited<ReturnType<typeof validateConversationContent>>;

describe('draft conversation content completeness', () => {
  let kb: Kb;
  const snapshot = new Map<string, Buffer>();
  beforeAll(async () => {
    kb = await Kb.load(new FsKbSource(root));
    for (const path of kb.paths()) snapshot.set(path, await kb.bytes(path));
  });

  async function fixture(changes: Record<string, string | null> = {}, approved = false) {
    const files = new Map(snapshot);
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) files.delete(path);
      else files.set(path, Buffer.from(text));
    }
    const source: KbSource = {
      list: async () => [...files.keys()].sort(),
      read: async (path) => {
        const value = files.get(path);
        if (!value) throw new Error(`fixture missing: ${path}`);
        return value;
      },
    };
    const manifest = await buildManifest(source, {
      version: '0.1.0',
      releasedAt: kb.manifest.releasedAt,
      reviewStatus: approved ? 'expert_approved' : 'draft_pending_expert_review',
      approvedBy: approved ? ['synthetic-test-only'] : [],
    });
    files.set(MANIFEST_PATH, Buffer.from(JSON.stringify(manifest)));
    return Kb.load(source);
  }

  async function editReview(
    edit: (review: Review) => void,
    changes: Record<string, string | null> = {},
    approved = false,
  ) {
    const review = parse(await kb.text(CONTENT_REVIEW_PATH)) as Review;
    edit(review);
    return fixture({ ...changes, [CONTENT_REVIEW_PATH]: stringify(review) }, approved);
  }

  it('has substantive and honestly labelled prompts for every character and grade', async () => {
    const paths = [
      ...CHARACTER_IDS.map((id) => `prompts/persona/${id}.md`),
      ...GRADE_BANDS.map((id) => `prompts/grade/${id}.md`),
    ];
    for (const path of paths) {
      const text = await kb.text(path);
      expect(text, path).not.toMatch(/プレースホルダー|専門家の補足待ち|\bTODO\b|\bTBD\b/);
      expect(text, path).toContain('DRAFT / 専門家未レビュー');
      expect(text, path).toContain('## 出典');
    }
  });

  it('has topic-specific skills with all three grade examples and bounded guidance', async () => {
    const paths = kb
      .paths('skills/')
      .filter((path) => path.endsWith('.md') && !path.endsWith('/README.md'));
    expect(paths).toHaveLength(11);
    expect(paths.every((path) => !path.includes('placeholder'))).toBe(true);
    for (const path of paths) {
      const text = await kb.text(path);
      for (const heading of ['場面', '最初の応答', '次の一歩', '学年帯別の例', '境界', '出典']) {
        expect(text, path).toContain(`## ${heading}`);
      }
      for (const grade of GRADE_BANDS) expect(text, path).toContain(`- ${grade}:`);
      expect(text, path).toContain('DRAFT / 専門家未レビュー');
    }
  });

  it('validates the full draft inventory, retaining empty expert approval', async () => {
    const review = await validateConversationContent(kb);
    expect(review.documents).toHaveLength(20);
    expect(kb.manifest.reviewStatus).toBe('draft_pending_expert_review');
    expect(kb.manifest.approvedBy).toEqual([]);
    const manifest = await buildManifest(new FsKbSource(root), kb.manifest);
    expect(manifest).toEqual(kb.manifest);
  });

  it('rejects release of structurally complete but unapproved content', async () => {
    await expect(validateConversationContent(kb, { release: true })).rejects.toThrow(
      'not releasable',
    );
  });

  it('rejects a fabricated approval status without altering the real manifest', () => {
    expect(
      manifestSchema.safeParse({ ...kb.manifest, approvedBy: ['synthetic-test-only'] }).success,
    ).toBe(false);
    expect(
      manifestSchema.safeParse({ ...kb.manifest, reviewStatus: 'expert_approved' }).success,
    ).toBe(false);
    expect(
      manifestSchema.safeParse({
        ...kb.manifest,
        reviewStatus: 'expert_approved',
        approvedBy: [' '],
      }).success,
    ).toBe(false);
  });

  it('does not let a manifest approval relabel draft bodies', async () => {
    const changed = await editReview(
      (review) => {
        review.review_status = 'expert_approved';
      },
      {},
      true,
    );
    await expect(validateConversationContent(changed, { release: true })).rejects.toThrow(
      'draft body cannot be marked approved',
    );
  });

  it('rejects mismatching manifest and content review states', async () => {
    const changed = await editReview((review) => {
      review.review_status = 'expert_approved';
    });
    await expect(validateConversationContent(changed)).rejects.toThrow('must match');
  });

  it('rejects a missing review inventory even with valid hashes', async () => {
    const changed = await fixture({ [CONTENT_REVIEW_PATH]: null });
    await expect(validateConversationContent(changed)).rejects.toThrow('file not in manifest');
  });

  it('rejects a required character removed from both content and inventory', async () => {
    const changed = await editReview(
      (review) => {
        review.documents = review.documents.filter(
          (doc) => doc.path !== 'prompts/persona/hidden.md',
        );
      },
      { 'prompts/persona/hidden.md': null },
    );
    await expect(validateConversationContent(changed)).rejects.toThrow(
      'missing required character or grade',
    );
  });

  it('rejects a duplicate or unlisted runtime document', async () => {
    const duplicate = await editReview((review) => {
      review.documents.push(review.documents[0]!);
    });
    await expect(validateConversationContent(duplicate)).rejects.toThrow('duplicate content path');
    const unlisted = await fixture({ 'skills/unlisted.md': 'Unlisted runtime content' });
    await expect(validateConversationContent(unlisted)).rejects.toThrow('exactly cover');
  });

  it.each(['TODO', 'TBD', 'プレースホルダー', '専門家の補足待ち', 'placeholder'])(
    'rejects %s after checksums are recomputed',
    async (marker) => {
      const path = 'prompts/persona/moko.md';
      const changed = await fixture({ [path]: `${await kb.text(path)}\n${marker}` });
      await expect(validateConversationContent(changed)).rejects.toThrow('placeholder content');
    },
  );

  it('rejects missing review disclosure, empty guidance and absent low-grade examples', async () => {
    const path = 'skills/exclusion.md';
    const text = await kb.text(path);
    const noDisclosure = await fixture({ [path]: text.replace('DRAFT / 専門家未レビュー', '') });
    await expect(validateConversationContent(noDisclosure)).rejects.toThrow('draft marker');
    const emptySection = await fixture({
      [path]: text.replace(/## 最初の応答\n[\s\S]*?\n## 次の一歩/, '## 最初の応答\n\n## 次の一歩'),
    });
    await expect(validateConversationContent(emptySection)).rejects.toThrow('empty section');
    const noExample = await fixture({ [path]: text.replace(/^- low:.*$/m, '') });
    await expect(validateConversationContent(noExample)).rejects.toThrow('example for low');
  });

  it('rejects an unknown source or a declared topic absent from the text', async () => {
    const unknown = await editReview((review) => {
      review.documents[0]!.sources.push('unverified');
    });
    await expect(validateConversationContent(unknown)).rejects.toThrow('source attribution');
    const missing = await editReview((review) => {
      review.documents.find((doc) => doc.path.startsWith('skills/'))!.topics = [
        'TopicNotInThisDocument',
      ];
    });
    await expect(validateConversationContent(missing)).rejects.toThrow('skill topics');
  });

  it('cites existing product requirements without presenting them as clinical evidence', async () => {
    const review = await validateConversationContent(kb);
    for (const source of Object.values(review.sources)) {
      const text = source.path.startsWith('docs/')
        ? await readFile(resolve(repo, source.path), 'utf8')
        : await kb.text(source.path);
      expect(source.kind).toBe('product_requirement');
      for (const section of source.sections) expect(text).toContain(section);
    }
  });

  it('covers the eight MEXT bullying forms with explicit A signals for every grade band', async () => {
    const definitions = await Promise.all(
      kb
        .paths('signals/')
        .filter((path) => path.endsWith('.yaml'))
        .map((path) => kb.yaml(path, signalDefinitionSchema)),
    );
    const a = definitions.filter((definition) => definition.domain === 'a');
    const model = a.filter((definition) => definition.method === 'model');
    expect(model.map((d) => d.signal_id).sort()).toEqual([
      'A-CYBER-001',
      'A-EXCL-003',
      'A-EXTORT-001',
      'A-FORCE-001',
      'A-PHYSH-001',
      'A-PHYSL-001',
      'A-PROP-001',
      'A-TEASE-001',
    ]);
    for (const d of model) {
      expect(d.grade_bands, d.signal_id).toEqual([...GRADE_BANDS]);
      expect(d.explicit, d.signal_id).toBe(true);
      expect(d.reviewed_by, d.signal_id).toBe('未定');
      for (const band of GRADE_BANDS) {
        expect(
          d.examples_by_grade?.[band]?.length ?? 0,
          `${d.signal_id} ${band}`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
    expect(
      definitions
        .filter((d) => d.domain === 'd' && d.scoring === 'observe')
        .map((d) => d.signal_id)
        .sort(),
    ).toEqual([
      'D-ENCL-001',
      'D-ISLCTR-001',
      'D-ISLNEAR-001',
      'D-ISO-001',
      'D-NEAR-001',
      'D-SELF-001',
    ]);
    expect(
      definitions
        .filter((d) => d.domain === 'x')
        .map((d) => d.metric)
        .sort(),
    ).toEqual([
      'x_class_change_flag',
      'x_exam_flag',
      'x_long_vacation_flag',
      'x_school_event_flag',
      'x_sick_flag',
      'x_travel_flag',
    ]);
    expect(
      a
        .filter(
          (definition) => definition.method === 'rule' && definition.grade_bands.includes('low'),
        )
        .map((definition) => definition.signal_id),
    ).toEqual(['A-SCHL-001', 'A-TOPIC-001', 'A-VAL-001']);
  });
});
