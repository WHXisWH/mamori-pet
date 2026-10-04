import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { CHARACTER_IDS, GRADE_BANDS } from '@ijime/api-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import {
  CONTENT_REVIEW_PATH,
  DRAFT_MARKER,
  isConversationContent,
  LITERATURE_MARKER,
  validateConversationContent,
} from '../src/content.js';
import { buildManifest, Kb, MANIFEST_PATH } from '../src/kb.js';
import {
  manifestSchema,
  signalDefinitionSchema,
  sourceRegistrySchema,
  type Manifest,
} from '../src/schemas.js';
import { FsKbSource, type KbSource } from '../src/source.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const repo = resolve(root, '../..');

type Review = Awaited<ReturnType<typeof validateConversationContent>>;
type ReviewStatus = NonNullable<Manifest['reviewStatus']>;

const REGISTRY_PATH = 'sources/registry.yaml';
const EVIDENCE_SKILL_PATH = 'skills/bedtime.md';
const EVIDENCE_SOURCE_ID = 'evidence_bedtime';

describe('conversation content completeness', () => {
  let kb: Kb;
  const snapshot = new Map<string, Buffer>();
  beforeAll(async () => {
    kb = await Kb.load(new FsKbSource(root));
    for (const path of kb.paths()) snapshot.set(path, await kb.bytes(path));
  });

  async function fixture(
    changes: Record<string, string | null> = {},
    status: ReviewStatus = 'literature_reviewed',
  ) {
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
      reviewStatus: status,
      approvedBy: status === 'expert_approved' ? ['synthetic-test-only'] : [],
    });
    files.set(MANIFEST_PATH, Buffer.from(JSON.stringify(manifest)));
    return Kb.load(source);
  }

  async function editReview(
    edit: (review: Review) => void,
    changes: Record<string, string | null> = {},
    status: ReviewStatus = 'literature_reviewed',
  ) {
    const review = parse(await kb.text(CONTENT_REVIEW_PATH)) as Review;
    edit(review);
    return fixture({ ...changes, [CONTENT_REVIEW_PATH]: stringify(review) }, status);
  }

  // The real KB is past the draft stage, so draft-specific guarantees run against this variant.
  async function draftBodies(): Promise<Record<string, string>> {
    const entries = await Promise.all(
      kb
        .paths()
        .filter(isConversationContent)
        .map(
          async (path) =>
            [path, (await kb.text(path)).replaceAll(LITERATURE_MARKER, DRAFT_MARKER)] as const,
        ),
    );
    return Object.fromEntries(entries);
  }

  async function draftKb(changes: Record<string, string | null> = {}) {
    return editReview(
      (review) => {
        review.review_status = 'draft_pending_expert_review';
      },
      { ...(await draftBodies()), ...changes },
      'draft_pending_expert_review',
    );
  }

  it('has substantive and honestly labelled prompts for every character and grade', async () => {
    const paths = [
      ...CHARACTER_IDS.map((id) => `prompts/persona/${id}.md`),
      ...GRADE_BANDS.map((id) => `prompts/grade/${id}.md`),
    ];
    for (const path of paths) {
      const text = await kb.text(path);
      expect(text, path).not.toMatch(/プレースホルダー|専門家の補足待ち|\bTODO\b|\bTBD\b/);
      expect(text, path).toContain(LITERATURE_MARKER);
      expect(text, path).not.toContain(DRAFT_MARKER);
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
      expect(text, path).toContain(LITERATURE_MARKER);
      expect(text, path).not.toContain(DRAFT_MARKER);
    }
  });

  it('validates the full literature-reviewed inventory, retaining empty expert approval', async () => {
    const review = await validateConversationContent(kb);
    expect(review.documents).toHaveLength(20);
    expect(review.review_status).toBe('literature_reviewed');
    expect(kb.manifest.reviewStatus).toBe('literature_reviewed');
    expect(kb.manifest.approvedBy).toEqual([]);
    const manifest = await buildManifest(new FsKbSource(root), kb.manifest);
    expect(manifest).toEqual(kb.manifest);
  });

  it('rejects release of structurally complete, literature-reviewed but unapproved content', async () => {
    // Arrange
    expect(kb.manifest.reviewStatus).toBe('literature_reviewed');

    // Act
    const released = validateConversationContent(kb, { release: true });

    // Assert
    await expect(released).rejects.toThrow('not releasable');
  });

  it('rejects release of a draft variant', async () => {
    // Arrange
    const draft = await draftKb();

    // Act
    const released = validateConversationContent(draft, { release: true });

    // Assert
    await expect(released).rejects.toThrow('not releasable');
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

  it('rejects a literature-reviewed manifest that names an approver', () => {
    // Arrange
    const manifest = { ...kb.manifest, approvedBy: ['synthetic-test-only'] };

    // Act
    const result = manifestSchema.safeParse(manifest);

    // Assert
    expect(manifest.reviewStatus).toBe('literature_reviewed');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['approvedBy'],
        message: 'a literature review is not an expert approval',
      }),
    ]);
  });

  it('accepts a literature-reviewed manifest only with empty approval', () => {
    // Arrange
    const manifest = { ...kb.manifest, reviewStatus: 'literature_reviewed', approvedBy: [] };

    // Act
    const result = manifestSchema.safeParse(manifest);

    // Assert
    expect(result.success).toBe(true);
  });

  it('rejects a draft manifest that names an approver', () => {
    // Arrange
    const manifest = {
      ...kb.manifest,
      reviewStatus: 'draft_pending_expert_review',
      approvedBy: ['synthetic-test-only'],
    };

    // Act
    const result = manifestSchema.safeParse(manifest);

    // Assert
    expect(result.success).toBe(false);
  });

  it('accepts a draft variant whose documents carry the draft marker', async () => {
    // Arrange
    const draft = await draftKb();

    // Act
    const review = await validateConversationContent(draft);

    // Assert
    expect(review.review_status).toBe('draft_pending_expert_review');
    expect(draft.manifest.approvedBy).toEqual([]);
  });

  it('rejects a draft document that drops the honest draft marker', async () => {
    // Arrange
    const path = 'skills/exclusion.md';
    const unlabelled = (await kb.text(path)).replaceAll(LITERATURE_MARKER, '');
    const draft = await draftKb({ [path]: unlabelled });

    // Act
    const validated = validateConversationContent(draft);

    // Assert
    await expect(validated).rejects.toThrow('missing honest draft marker');
  });

  it('does not let a manifest approval relabel literature-reviewed bodies', async () => {
    // Arrange: every document of the real KB still carries the unsigned marker
    const changed = await editReview(
      (review) => {
        review.review_status = 'expert_approved';
      },
      {},
      'expert_approved',
    );

    // Act / Assert
    await expect(validateConversationContent(changed, { release: true })).rejects.toThrow(
      'unsigned body cannot be marked approved',
    );
  });

  it('does not let a manifest approval relabel draft bodies', async () => {
    const changed = await editReview(
      (review) => {
        review.review_status = 'expert_approved';
      },
      await draftBodies(),
      'expert_approved',
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
    const noDisclosure = await fixture({ [path]: text.replace(LITERATURE_MARKER, '') });
    await expect(validateConversationContent(noDisclosure)).rejects.toThrow(
      'missing literature review marker',
    );
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
    const requirements = Object.values(review.sources).filter(
      (source) => source.path !== REGISTRY_PATH,
    );
    expect(requirements.length).toBeGreaterThan(0);
    for (const source of requirements) {
      const text = source.path.startsWith('docs/')
        ? await readFile(resolve(repo, source.path), 'utf8')
        : await kb.text(source.path);
      expect(source.kind).toBe('product_requirement');
      for (const section of source.sections) expect(text).toContain(section);
    }
  });

  it('backs every real skill with registered evidence that its 出典 section names', async () => {
    // Arrange
    const registry = await kb.yaml(REGISTRY_PATH, sourceRegistrySchema);
    const registered = new Set(registry.sources.map((source) => source.id));

    // Act
    const review = await validateConversationContent(kb);

    // Assert
    const skills = review.documents.filter((doc) => doc.path.startsWith('skills/'));
    expect(skills).toHaveLength(11);
    for (const doc of skills) {
      const evidence = doc.sources
        .map((id) => review.sources[id]!)
        .filter((source) => source.kind === 'evidence_registry');
      expect(evidence.length, doc.path).toBeGreaterThan(0);
      const citations = (await kb.text(doc.path)).split('## 出典')[1]!;
      for (const id of evidence.flatMap((source) => source.sections)) {
        expect(registered.has(id), `${doc.path} ${id}`).toBe(true);
        expect(citations, doc.path).toContain(id);
      }
    }
  });

  it('rejects a literature-reviewed document that still carries the draft marker', async () => {
    // Arrange
    const path = 'prompts/persona/moko.md';
    const changed = await fixture({ [path]: `${await kb.text(path)}\n${DRAFT_MARKER}\n` });

    // Act
    const validated = validateConversationContent(changed);

    // Assert
    await expect(validated).rejects.toThrow('draft body cannot be marked literature reviewed');
  });

  it.each(['prompts/persona/moko.md', 'prompts/grade/low.md', EVIDENCE_SKILL_PATH])(
    'rejects literature-reviewed %s without the literature marker',
    async (path) => {
      // Arrange
      const changed = await fixture({
        [path]: (await kb.text(path)).replaceAll(LITERATURE_MARKER, ''),
      });

      // Act
      const validated = validateConversationContent(changed);

      // Assert
      await expect(validated).rejects.toThrow('missing literature review marker');
    },
  );

  it('rejects a literature-reviewed skill that cites no evidence registry source', async () => {
    // Arrange
    const changed = await editReview((review) => {
      const skill = review.documents.find((doc) => doc.path === EVIDENCE_SKILL_PATH)!;
      skill.sources = skill.sources.filter((id) => id !== EVIDENCE_SOURCE_ID);
    });

    // Act
    const validated = validateConversationContent(changed);

    // Assert
    await expect(validated).rejects.toThrow(
      'literature_reviewed requires registered evidence for every skill',
    );
  });

  it('rejects an evidence id that is not in the source registry', async () => {
    // Arrange
    const changed = await editReview((review) => {
      review.sources[EVIDENCE_SOURCE_ID]!.sections.push('synthetic_unregistered_source');
    });

    // Act
    const validated = validateConversationContent(changed);

    // Assert
    await expect(validated).rejects.toThrow(
      'cites unregistered evidence synthetic_unregistered_source',
    );
  });

  it('rejects a registered evidence id that the skill does not name under 出典', async () => {
    // Arrange
    const uncited = 'childline_japan';
    const registry = await kb.yaml(REGISTRY_PATH, sourceRegistrySchema);
    expect(registry.sources.map((source) => source.id)).toContain(uncited);
    expect(await kb.text(EVIDENCE_SKILL_PATH)).not.toContain(uncited);
    const changed = await editReview((review) => {
      review.sources[EVIDENCE_SOURCE_ID]!.sections.push(uncited);
    });

    // Act
    const validated = validateConversationContent(changed);

    // Assert
    await expect(validated).rejects.toThrow(`evidence ${uncited} is not cited`);
  });

  it('rejects an evidence id written outside the 出典 section only', async () => {
    // Arrange
    const uncited = 'childline_japan';
    const text = await kb.text(EVIDENCE_SKILL_PATH);
    const changed = await editReview(
      (review) => {
        review.sources[EVIDENCE_SOURCE_ID]!.sections.push(uncited);
      },
      { [EVIDENCE_SKILL_PATH]: text.replace('## 境界\n', `## 境界\n\n${uncited}\n`) },
    );

    // Act
    const validated = validateConversationContent(changed);

    // Assert
    await expect(validated).rejects.toThrow(`evidence ${uncited} is not cited`);
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
