import { createHash } from 'node:crypto';

import { FieldValue, Firestore } from '@google-cloud/firestore';
import { GRADE_BANDS, type GradeBand } from '@ijime/api-types';
import { agent, REGION } from '@ijime/config';
import { CONTENT_REVIEW_PATH, validateConversationContent, type Kb } from '@ijime/kb-loader';
import { AdcGoogleHttp, type GoogleHttp, type Logger } from '@ijime/service-kit';
import { z } from 'zod';

export const KB_CHUNKS_COLLECTION = 'kbChunks';
export const EMBEDDING_FIELD = 'embedding';
export const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSION = 768;
export const CHUNK_TARGET_CHARS = 400;
const GRADE_EXAMPLES_HEADING = '学年帯別の例';

export type EmbeddingTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface Embedder {
  readonly model: string;
  readonly dimension: number;
  embed(texts: string[], task: EmbeddingTask): Promise<number[][]>;
}

export function normalizeVector(values: number[]): number[] {
  const norm = Math.hypot(...values);
  return norm === 0 ? values : values.map((value) => value / norm);
}

const predictResponse = z.object({
  predictions: z.array(z.object({ embeddings: z.object({ values: z.array(z.number()) }) })),
});

export class VertexEmbedder implements Embedder {
  constructor(
    private readonly projectId: string,
    private readonly http: GoogleHttp = new AdcGoogleHttp(),
    readonly model: string = DEFAULT_EMBEDDING_MODEL,
    readonly dimension: number = EMBEDDING_DIMENSION,
  ) {}

  async embed(texts: string[], task: EmbeddingTask): Promise<number[][]> {
    const url = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${REGION}/publishers/google/models/${this.model}:predict`;
    const out: number[][] = [];
    for (const content of texts) {
      const result = predictResponse.parse(
        await this.http.request({
          method: 'POST',
          url,
          body: {
            instances: [{ content, task_type: task }],
            parameters: { outputDimensionality: this.dimension },
          },
        }),
      );
      const values = result.predictions[0]?.embeddings.values;
      if (!values || values.length !== this.dimension) throw new Error('embedding shape mismatch');
      out.push(normalizeVector(values));
    }
    return out;
  }
}

const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
const segments = (text: string) =>
  [...segmenter.segment(text.normalize('NFKC'))]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment);
const phraseKey = (text: string) => `\0${segments(text).join('\0')}\0`;

export class FakeEmbedder implements Embedder {
  readonly model = 'fake';

  constructor(readonly dimension: number = 64) {}

  async embed(texts: string[], _task?: EmbeddingTask): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimension).fill(0);
      for (const word of segments(text)) {
        const digest = createHash('sha256').update(word.toLowerCase()).digest();
        const index = digest.readUInt32BE(0) % this.dimension;
        vector[index] = vector[index]! + (digest[4]! & 1 ? 1 : -1);
      }
      return normalizeVector(vector);
    });
  }
}

export type SkillChunk = {
  skillId: string;
  chunkIndex: number;
  heading: string;
  text: string;
  gradeBands: GradeBand[];
  embeddingInput: string;
};

export function skillIdOf(path: string): string {
  return path.replace(/^skills\//, '').replace(/\.md$/, '');
}

function splitLong(text: string, target: number): string[] {
  if (text.length <= target) return [text];
  const sentences = text.match(/[^。]*。|[^。]+$/g) ?? [text];
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > target) {
      out.push(current);
      current = '';
    }
    current += sentence;
  }
  if (current) out.push(current);
  return out;
}

function pack(body: string, target: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const line of body.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && candidate.trim().length > target) {
      pieces.push(current);
      current = line;
    } else current = candidate;
  }
  if (current) pieces.push(current);
  return pieces.flatMap((piece) => splitLong(piece, target)).filter((p) => p.trim().length > 0);
}

export function chunkSkill(
  path: string,
  markdown: string,
  target = CHUNK_TARGET_CHARS,
): SkillChunk[] {
  const skillId = skillIdOf(path);
  const title = markdown.split('\n')[0]!.replace(/^#\s+/, '').trim();
  const parts = markdown.split(/^## /m);
  const sections: { heading: string; body: string }[] = [
    { heading: title, body: parts[0]!.split('\n').slice(1).join('\n').trim() },
    ...parts.slice(1).map((part) => {
      const newline = part.indexOf('\n');
      return { heading: part.slice(0, newline).trim(), body: part.slice(newline + 1).trim() };
    }),
  ];
  const chunks: SkillChunk[] = [];
  for (const { heading, body } of sections) {
    for (const text of pack(body, target)) {
      const grades =
        heading === GRADE_EXAMPLES_HEADING
          ? GRADE_BANDS.filter((grade) => new RegExp(`^- ${grade}: `, 'm').test(text))
          : [];
      chunks.push({
        skillId,
        chunkIndex: chunks.length,
        heading,
        text: text.trim(),
        gradeBands: grades.length > 0 ? grades : [...GRADE_BANDS],
        embeddingInput: `${title}\n${heading}\n${text.trim()}`,
      });
    }
  }
  return chunks;
}

export function kbChunkId(kbVersion: string, skillId: string, chunkIndex: number): string {
  return `${kbVersion}__${skillId}__${chunkIndex}`;
}

export function kbChunkDocument(
  chunk: SkillChunk,
  vector: number[],
  meta: { kbVersion: string; approved: boolean; embeddingModel: string },
): Record<string, unknown> {
  return {
    kbVersion: meta.kbVersion,
    skillId: chunk.skillId,
    chunkIndex: chunk.chunkIndex,
    heading: chunk.heading,
    text: chunk.text,
    [EMBEDDING_FIELD]: FieldValue.vector(vector),
    embeddingModel: meta.embeddingModel,
    approved: meta.approved,
    gradeBands: chunk.gradeBands,
    createdAt: FieldValue.serverTimestamp(),
  };
}

export type KbChunkHit = {
  skillId: string;
  chunkIndex: number;
  text: string;
  distance?: number | undefined;
};

export interface KbChunkStore {
  nearest(input: { kbVersion: string; vector: number[]; limit: number }): Promise<KbChunkHit[]>;
}

export class VectorSearchUnsupportedError extends Error {
  constructor(readonly code: string) {
    super('vector search unsupported');
    this.name = 'VectorSearchUnsupportedError';
  }
}

const hitSchema = z.object({
  skillId: z.string(),
  chunkIndex: z.number().int(),
  text: z.string(),
  distance: z.number().optional(),
});

const UNSUPPORTED_CODES = new Set([3, 9, 12]);

export class FirestoreKbChunkStore implements KbChunkStore {
  constructor(private readonly db: Firestore) {}

  async nearest(input: { kbVersion: string; vector: number[]; limit: number }) {
    try {
      const snapshot = await this.db
        .collection(KB_CHUNKS_COLLECTION)
        .where('kbVersion', '==', input.kbVersion)
        .where('approved', '==', true)
        .findNearest({
          vectorField: EMBEDDING_FIELD,
          queryVector: input.vector,
          limit: input.limit,
          distanceMeasure: 'COSINE',
          distanceResultField: 'distance',
        })
        .get();
      return snapshot.docs.map((doc) => hitSchema.parse(doc.data()));
    } catch (err) {
      const code = (err as { code?: number | string }).code;
      if (typeof code === 'number' && UNSUPPORTED_CODES.has(code))
        throw new VectorSearchUnsupportedError(String(code));
      throw err;
    }
  }
}

export type SkillSearchDeps = {
  embedder?: Embedder;
  chunks?: KbChunkStore;
  db?: Firestore;
  logger?: Pick<Logger, 'warn'>;
};

export function vectorSearchEnabled(env: NodeJS.ProcessEnv, deps: SkillSearchDeps): boolean {
  if (deps.chunks) return true;
  return (
    env['NODE_ENV'] === 'production' && !env['FIRESTORE_EMULATOR_HOST'] && !!env['GCP_PROJECT_ID']
  );
}

export async function createSkillSearch(
  kb: Kb,
  env: NodeJS.ProcessEnv = process.env,
  deps: SkillSearchDeps = {},
) {
  const review = kb.has(CONTENT_REVIEW_PATH) ? await validateConversationContent(kb) : undefined;
  const topicsByPath = new Map(review?.documents.map((doc) => [doc.path, doc.topics ?? []]));
  // Only explicitly declared one-character topics are eligible, not arbitrary name fragments.
  const singleTerms = new Set(
    [...topicsByPath.values()].flat().filter((topic) => /^\p{Script=Han}$/u.test(topic)),
  );
  const words = (text: string) =>
    segments(text).filter((word) => word.length > 1 || singleTerms.has(word));
  const documents = await Promise.all(
    kb
      .paths('skills/')
      .filter((path) => path.endsWith('.md') && !path.endsWith('/README.md'))
      .map(async (path) => {
        const text = await kb.text(path);
        const topics = topicsByPath.get(path) ?? [text.split('\n')[0]!.replace(/^#\s+/, '')];
        return {
          path,
          text,
          phrases: topics.map(phraseKey),
          topicTerms: new Set(topics.flatMap(words)),
          terms: new Set(words(text)),
        };
      }),
  );
  const byPath = new Map(documents.map((doc) => [doc.path, doc]));
  const documentFrequency = new Map<string, number>();
  for (const doc of documents) {
    for (const term of doc.terms)
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  let vector = vectorSearchEnabled(env, deps);
  let embedder = deps.embedder;
  let chunks = deps.chunks;
  const ensureVector = (): { embedder: Embedder; chunks: KbChunkStore } => {
    const projectId = env['GCP_PROJECT_ID'];
    if (!embedder) {
      if (!projectId) throw new Error('vector skill search requires GCP_PROJECT_ID');
      embedder = new VertexEmbedder(projectId, undefined, env['EMBEDDING_MODEL']);
    }
    if (!chunks) {
      chunks = new FirestoreKbChunkStore(deps.db ?? new Firestore(projectId ? { projectId } : {}));
    }
    return { embedder, chunks };
  };
  const passage = (doc: { path: string; text: string }) =>
    JSON.stringify({ kind: 'reference', kbVersion: kb.version, path: doc.path, text: doc.text });
  const lexical = (terms: string[], query: string) => {
    const queryPhrase = phraseKey(query);
    const score = (vocabulary: Set<string>) =>
      terms.reduce(
        (sum, term) =>
          sum +
          (vocabulary.has(term) ? Math.log1p(documents.length / documentFrequency.get(term)!) : 0),
        0,
      );
    return documents
      .map((doc) => ({
        doc,
        phraseMatches: doc.phrases.filter((phrase) => queryPhrase.includes(phrase)).length,
        topicScore: score(doc.topicTerms),
        bodyScore: score(doc.terms),
      }))
      .filter((item) => item.bodyScore > 0)
      .sort(
        (a, b) =>
          b.phraseMatches - a.phraseMatches ||
          b.topicScore - a.topicScore ||
          b.bodyScore - a.bodyScore ||
          (a.doc.path < b.doc.path ? -1 : a.doc.path > b.doc.path ? 1 : 0),
      )
      .map((item) => item.doc);
  };
  const semantic = async (terms: string[]) => {
    const { embedder, chunks } = ensureVector();
    const [queryVector] = await embedder.embed([terms.join(' ')], 'RETRIEVAL_QUERY');
    const hits = await chunks.nearest({
      kbVersion: kb.version,
      vector: queryVector!,
      limit: agent.searchSkillMaxPassages,
    });
    const selected: { path: string; text: string }[] = [];
    for (const hit of hits) {
      const doc = byPath.get(`skills/${hit.skillId}.md`);
      if (!doc || hit.text.trim().length === 0 || !doc.text.includes(hit.text)) continue;
      if (!selected.some((item) => item.path === doc.path)) selected.push(doc);
    }
    return selected;
  };
  return async (query: string): Promise<string[]> => {
    if (env['NODE_ENV'] === 'production' && kb.manifest.approvedBy.length === 0) return [];
    const terms = [...new Set(words(query).filter((word) => documentFrequency.has(word)))];
    if (terms.length === 0) return [];
    if (vector) {
      try {
        const selected = await semantic(terms);
        if (selected.length > 0)
          return selected.slice(0, agent.searchSkillMaxPassages).map(passage);
      } catch (err) {
        if (!(err instanceof VectorSearchUnsupportedError)) throw err;
        vector = false;
        deps.logger?.warn('skill_search_vector_unavailable', {
          code: err.code,
          kbVersion: kb.version,
        });
      }
    }
    return lexical(terms, query).slice(0, agent.searchSkillMaxPassages).map(passage);
  };
}
