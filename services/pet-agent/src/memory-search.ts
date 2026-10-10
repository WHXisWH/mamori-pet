import { createHash } from 'node:crypto';

import {
  FieldValue,
  VectorValue,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from '@google-cloud/firestore';
import { childPath, type ChildRecord, type FirestoreSessionService } from '@ijime/agent-core';
import { agent, REGION } from '@ijime/config';
import type { Logger } from '@ijime/service-kit';

import { asDate } from './context.js';
import { EMBEDDING_DIMENSION, VertexEmbedder, type Embedder } from './skills.js';

export const MEMORY_SEARCH_ENV = 'MEMORY_VECTOR_SEARCH';

// undefined requests the existing lexical fallback; [] is an authoritative empty result.
// The executor supplies a query sanitized by the same privacy memo as memory proposals.
export type MemorySearch = (child: ChildRecord, query: string) => Promise<string[] | undefined>;

export function recallableMemory(data: DocumentData, child: ChildRecord, now: Date): boolean {
  return (
    !data['deletedAt'] &&
    !data['revokedAt'] &&
    !['pending', 'rejected', 'deleted', 'revoked'].includes(data['status']) &&
    !!(
      data['consentedAt'] ||
      data['consentAt'] ||
      data['acceptedAt'] ||
      data['status'] === 'accepted'
    ) &&
    data['characterId'] === child.characterId &&
    (!data['petId'] || data['petId'] === child.petId) &&
    (asDate(data['expiresAt']) ?? asDate(data['expireAt']) ?? new Date(8640000000000000)) > now
  );
}

function contentHash(data: DocumentData): string {
  return createHash('sha256').update(Buffer.from(data['contentEnc'])).digest('hex');
}

function revision(owner: DocumentSnapshot): string {
  return JSON.stringify([
    owner.get('memoryRevision') ?? 0,
    asDate(owner.get('modelHistoryResetAt'))?.getTime() ?? null,
  ]);
}

export function createMemorySearch(
  env: NodeJS.ProcessEnv,
  deps: {
    db: Firestore;
    sessions: FirestoreSessionService;
    embedder?: Embedder;
    logger?: Pick<Logger, 'warn'>;
  },
): MemorySearch | undefined {
  if (env[MEMORY_SEARCH_ENV] !== 'true') return undefined;
  if (env['GCP_REGION'] && env['GCP_REGION'] !== REGION) return undefined;
  if (!deps.embedder && !env['GCP_PROJECT_ID']) return undefined;
  let embedder = deps.embedder;

  return async (child, query) => {
    if (!query.trim()) return [];
    const { db, sessions } = deps;
    const base = childPath(child.familyId, child.childId);
    const ownerRef = db.doc(base);
    const petRef = db.doc(`${base}/pets/${child.petId}`);
    const memories = db.collection(`${base}/memories`);
    const deadline = Date.now() + agent.firstTokenTimeoutMs;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = () => active && Date.now() < deadline;
    const ownerValid = async (tx: Transaction, expectedRevision?: string) => {
      const [owner, pet] = await tx.getAll(ownerRef, petRef);
      if (
        !live() ||
        !owner?.exists ||
        owner.get('status') !== 'active' ||
        owner.get('childId') !== child.childId ||
        owner.get('familyId') !== child.familyId ||
        (owner.get('activePetId') && owner.get('activePetId') !== child.petId) ||
        !pet?.exists ||
        pet.get('active') !== true ||
        pet.get('characterId') !== child.characterId ||
        (expectedRevision !== undefined && revision(owner) !== expectedRevision)
      )
        return undefined;
      return revision(owner);
    };
    const eligible = (doc: DocumentSnapshot) =>
      doc.exists &&
      doc.get('petId') === child.petId &&
      recallableMemory(doc.data()!, child, new Date());

    const run = async (): Promise<string[] | undefined> => {
      const initial = await db.runTransaction(async (tx) => {
        const version = await ownerValid(tx);
        if (version === undefined) return undefined;
        const snapshot = await tx.get(
          memories
            .orderBy('createdAt', 'desc')
            .limit(agent.contextHistoryTurns * agent.recallMaxMemories),
        );
        return { version, docs: snapshot.docs.filter(eligible) };
      });
      if (!initial) return [];
      if (initial.docs.length === 0) return undefined;
      const model = (embedder ??= new VertexEmbedder(
        env['GCP_PROJECT_ID']!,
        undefined,
        env['EMBEDDING_MODEL'],
      ));
      if (model.dimension !== EMBEDDING_DIMENSION) throw new Error('memory_embedding_dimension');
      const currentVector = (doc: DocumentSnapshot) =>
        doc.get('embedding') instanceof VectorValue &&
        (doc.get('embedding') as VectorValue).toArray().length === EMBEDDING_DIMENSION &&
        doc.get('embeddingModel') === model.model &&
        doc.get('embeddingContentHash') === contentHash(doc.data()!);
      const checkedVector = async (
        text: string,
        task: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT',
      ) => {
        if (!live()) throw new Error('memory_search_timeout');
        const [vector] = await model.embed([text], task);
        if (
          !live() ||
          !vector ||
          vector.length !== EMBEDDING_DIMENSION ||
          !vector.every(Number.isFinite) ||
          Math.hypot(...vector) === 0
        )
          throw new Error('memory_embedding_invalid');
        return vector;
      };

      // Only accepted memory documents are indexed, with bounded lazy backfill per recall.
      for (const original of initial.docs
        .filter((doc) => !currentVector(doc))
        .slice(0, agent.recallMaxMemories)) {
        const before = await db.runTransaction(async (tx) => {
          if ((await ownerValid(tx, initial.version)) === undefined) return undefined;
          const doc = await tx.get(original.ref);
          return eligible(doc) && doc.updateTime?.isEqual(original.updateTime!) ? doc : undefined;
        });
        if (!before) continue;
        const vector = await checkedVector(
          sessions.decryptForChild(
            child,
            Buffer.from(before.get('contentEnc')),
            `${memories.path}#contentEnc`,
          ),
          'RETRIEVAL_DOCUMENT',
        );
        await db.runTransaction(async (tx) => {
          if ((await ownerValid(tx, initial.version)) === undefined) return;
          const fresh = await tx.get(before.ref);
          if (!live() || !eligible(fresh) || !fresh.updateTime?.isEqual(before.updateTime!)) return;
          // update, never set: deletion cannot recreate a document or leave an orphan vector.
          tx.update(fresh.ref, {
            embedding: FieldValue.vector(vector),
            embeddingModel: model.model,
            embeddingContentHash: contentHash(fresh.data()!),
          });
        });
      }

      if ((await db.runTransaction((tx) => ownerValid(tx, initial.version))) === undefined)
        return [];
      const vector = await checkedVector(query, 'RETRIEVAL_QUERY');
      const nearest = await memories
        .where('characterId', '==', child.characterId)
        .where('petId', '==', child.petId)
        .where('embeddingModel', '==', model.model)
        .findNearest({
          vectorField: 'embedding',
          queryVector: vector,
          distanceMeasure: 'COSINE',
          limit: agent.recallMaxMemories,
        })
        .get();
      return db.runTransaction(async (tx) => {
        if ((await ownerValid(tx, initial.version)) === undefined) return [];
        if (nearest.empty) return undefined;
        const fresh = await tx.getAll(...nearest.docs.map((doc) => doc.ref));
        if (!live()) return [];
        const selected = fresh.filter((doc) => eligible(doc) && currentVector(doc));
        return selected.length === 0
          ? undefined
          : selected.map((doc) =>
              sessions.decryptForChild(
                child,
                Buffer.from(doc.get('contentEnc')),
                `${memories.path}#contentEnc`,
              ),
            );
      });
    };

    try {
      return await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            active = false;
            reject(new Error('memory_search_timeout'));
          }, agent.firstTokenTimeoutMs);
        }),
      ]);
    } catch {
      // Provider errors may contain child text; never log error objects or query strings.
      deps.logger?.warn('memory_search_unavailable');
      return undefined;
    } finally {
      active = false;
      clearTimeout(timer);
    }
  };
}
