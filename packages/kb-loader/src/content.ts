import { CHARACTER_IDS, GRADE_BANDS } from '@ijime/api-types';
import { z } from 'zod';

import { KbIntegrityError, type Kb } from './kb.js';
import { reviewStatusSchema, SOURCE_ID_PATTERN, sourceRegistrySchema } from './schemas.js';

export const CONTENT_REVIEW_PATH = 'content-review.yaml';
export const DRAFT_MARKER = 'DRAFT / 専門家未レビュー';
export const LITERATURE_MARKER = '文献確認済み / 専門家未署名';
const EVIDENCE_REGISTRY_PATH = 'sources/registry.yaml';
const placeholders = /プレースホルダー|専門家の補足待ち|\bTODO\b|\bTBD\b|placeholder/i;
const contentPath = /^(?:prompts\/(?:persona|grade)|skills)\/[a-z][a-z-]*\.md$/;

const contentReviewSchema = z.strictObject({
  review_status: reviewStatusSchema,
  scope: z.literal('everyday_conversation_not_clinical_guidance'),
  sources: z.record(
    z.string().min(1),
    z.union([
      z.strictObject({
        path: z.string().regex(/^(?:docs|prompts)\/[a-z0-9-]+\.md$/),
        sections: z.array(z.string().trim().min(1)).min(1),
        kind: z.literal('product_requirement'),
      }),
      // sections は出典登録簿の id。会話指針がどの文献に基づくかを示す。
      z.strictObject({
        path: z.literal(EVIDENCE_REGISTRY_PATH),
        sections: z.array(z.string().regex(SOURCE_ID_PATTERN)).min(1),
        kind: z.literal('evidence_registry'),
      }),
    ]),
  ),
  documents: z
    .array(
      z.strictObject({
        path: z.string().regex(contentPath),
        topics: z.array(z.string().trim().min(1)).min(1).optional(),
        sources: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  game_content: z
    .array(
      z.strictObject({
        path: z.string().regex(/^games\/[a-z_]+\.yaml$/),
        sources: z.array(z.string().min(1)).min(1),
      }),
    )
    .optional(),
});

function fail(message: string, path = CONTENT_REVIEW_PATH): never {
  throw new KbIntegrityError(`conversation content: ${message}`, path);
}

export function isConversationContent(path: string): boolean {
  return (
    path.endsWith('.md') &&
    !path.endsWith('/README.md') &&
    (path.startsWith('prompts/persona/') ||
      path.startsWith('prompts/grade/') ||
      path.startsWith('skills/'))
  );
}

/** Structural checks only. These cannot establish clinical safety or genuine expert approval. */
export async function validateConversationContent(kb: Kb, options: { release?: boolean } = {}) {
  const review = await kb.yaml(CONTENT_REVIEW_PATH, contentReviewSchema);
  if (!kb.manifest.reviewStatus || kb.manifest.reviewStatus !== review.review_status) {
    fail('manifest and content review status must match');
  }
  if (
    options.release &&
    (review.review_status !== 'expert_approved' || kb.manifest.approvedBy.length === 0)
  ) {
    fail('unapproved draft content is not releasable');
  }
  const paths = kb.paths().filter(isConversationContent);
  const declared = review.documents.map((doc) => doc.path);
  if (new Set(declared).size !== declared.length) fail('duplicate content path');
  if (paths.length !== declared.length || paths.some((path) => !declared.includes(path))) {
    fail('review inventory must exactly cover runtime persona, grade and skill files');
  }
  for (const path of [
    ...CHARACTER_IDS.map((id) => `prompts/persona/${id}.md`),
    ...GRADE_BANDS.map((id) => `prompts/grade/${id}.md`),
  ]) {
    if (!declared.includes(path)) fail('missing required character or grade', path);
  }
  if (!declared.some((path) => path.startsWith('skills/'))) fail('no conversation skills');
  for (const game of review.game_content ?? []) {
    if (!kb.has(game.path)) fail('unknown game content path', game.path);
    for (const sourceId of game.sources)
      if (!review.sources[sourceId]) fail('unknown source attribution', game.path);
  }
  const cited = Object.values(review.sources).some((source) => source.kind === 'evidence_registry');
  const registered = new Set(
    cited
      ? (await kb.yaml(EVIDENCE_REGISTRY_PATH, sourceRegistrySchema)).sources.map((s) => s.id)
      : [],
  );
  if (review.review_status === 'literature_reviewed') {
    const skills = review.documents.filter((doc) => doc.path.startsWith('skills/'));
    const backed = (doc: (typeof skills)[number]) =>
      doc.sources.some((id) => review.sources[id]?.kind === 'evidence_registry');
    if (!skills.every(backed))
      fail('literature_reviewed requires registered evidence for every skill');
  }
  for (const doc of review.documents) {
    const text = await kb.text(doc.path);
    if (placeholders.test(text) || placeholders.test(doc.path))
      fail('placeholder content', doc.path);
    if (review.review_status === 'draft_pending_expert_review' && !text.includes(DRAFT_MARKER)) {
      fail('missing honest draft marker', doc.path);
    }
    if (review.review_status === 'expert_approved' && text.includes(DRAFT_MARKER)) {
      fail('draft body cannot be marked approved', doc.path);
    }
    if (review.review_status === 'expert_approved' && text.includes(LITERATURE_MARKER)) {
      fail('unsigned body cannot be marked approved', doc.path);
    }
    if (review.review_status === 'literature_reviewed') {
      if (text.includes(DRAFT_MARKER))
        fail('draft body cannot be marked literature reviewed', doc.path);
      if (!text.includes(LITERATURE_MARKER)) fail('missing literature review marker', doc.path);
    }
    const skill = doc.path.startsWith('skills/');
    const headings = skill
      ? ['場面', '最初の応答', '次の一歩', '学年帯別の例', '境界', '出典']
      : doc.path.startsWith('prompts/persona/')
        ? ['性格と話し方', '日常の会話例', '困ったときと境界', '出典']
        : ['言葉と長さ', '選び方', '応答例', '境界', '出典'];
    const sections = new Map(
      text
        .split(/^## /m)
        .slice(1)
        .map((part) => {
          const newline = part.indexOf('\n');
          return [part.slice(0, newline).trim(), part.slice(newline + 1).trim()];
        }),
    );
    for (const heading of headings) {
      if (!sections.get(heading)) fail(`missing or empty section: ${heading}`, doc.path);
    }
    for (const sourceId of doc.sources) {
      const source = review.sources[sourceId];
      if (!source || !sections.get('出典')!.includes(source.path)) {
        fail('unknown or missing source attribution', doc.path);
      }
      if (source.kind === 'evidence_registry') {
        for (const id of source.sections) {
          if (!registered.has(id)) fail(`cites unregistered evidence ${id}`, doc.path);
          if (!sections.get('出典')!.includes(id)) fail(`evidence ${id} is not cited`, doc.path);
        }
      }
    }
    if (skill) {
      if (!doc.topics || doc.topics.some((topic) => !text.includes(topic)))
        fail('missing skill topics', doc.path);
      for (const grade of GRADE_BANDS) {
        if (!new RegExp(`^- ${grade}: .+`, 'm').test(sections.get('学年帯別の例')!)) {
          fail(`missing example for ${grade}`, doc.path);
        }
      }
    }
  }
  return review;
}
