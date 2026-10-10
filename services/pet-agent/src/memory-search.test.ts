import { FieldValue, Firestore, Query, Transaction, VectorValue } from '@google-cloud/firestore';
import {
  childPath,
  DevChildDirectory,
  FirestoreSessionService,
  PET_APP_NAME,
} from '@ijime/agent-core';
import { agent } from '@ijime/config';
import type { Kb } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createExecutor } from './executor.js';
import { createMemorySearch, MEMORY_SEARCH_ENV, type MemorySearch } from './memory-search.js';
import { EMBEDDING_DIMENSION, type Embedder, type EmbeddingTask } from './skills.js';
import type { NameDetector } from './pseudonyms.js';

let db: Firestore;
let directory: DevChildDirectory;
let sessions: FirestoreSessionService;
const kb = {} as Kb;
const env = { [MEMORY_SEARCH_ENV]: 'true', GCP_REGION: 'asia-northeast1' };
const logs: string[] = [];
const logger = new Logger('memory-search-test', (line) => logs.push(line));

beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-memory-search-${process.pid}` });
  directory = new DevChildDirectory(db);
  sessions = new FirestoreSessionService(db, directory);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => db.terminate());

function fakeEmbedder() {
  return {
    model: 'fake-memory-768',
    dimension: EMBEDDING_DIMENSION,
    embed: vi.fn(async (texts: string[], _task: EmbeddingTask): Promise<number[][]> =>
      texts.map((text) => {
        const vector = new Array<number>(EMBEDDING_DIMENSION).fill(0);
        vector[/サッカー|蹴球/.test(text) ? 0 : 1] = 1;
        return vector;
      }),
    ),
  } satisfies Embedder;
}

async function fixture(id: string) {
  const child = await directory.lookup(`c_search_${id}`);
  const base = childPath(child.familyId, child.childId);
  const collection = db.collection(`${base}/memories`);
  const embedder = fakeEmbedder();
  const search = createMemorySearch(env, { db, sessions, embedder, logger })!;
  const seed = async (memoryId: string, text: string, extra: Record<string, unknown> = {}) => {
    const ref = collection.doc(memoryId);
    await ref.set({
      category: 'like',
      petId: child.petId,
      characterId: child.characterId,
      createdAt: new Date(),
      consentedAt: new Date(),
      contentEnc: sessions.encryptForChild(child, text, `${collection.path}#contentEnc`),
      ...extra,
    });
    return ref;
  };
  const session = await sessions.createSession({ appName: PET_APP_NAME, userId: child.childId });
  const executor = (searchMemory?: MemorySearch, detectNames?: NameDetector) =>
    createExecutor({
      db,
      sessions,
      child,
      sessionId: session.id,
      kb,
      logger,
      searchSkill: async () => [],
      publish: async () => undefined,
      ...(searchMemory ? { searchMemory } : {}),
      ...(detectNames ? { detectNames } : {}),
    });
  const ctx = {
    childId: child.childId,
    sessionId: session.id,
    gradeBand: child.gradeBand,
    characterId: child.characterId,
  };
  return { child, base, collection, embedder, search, seed, executor, ctx, session };
}

describe('optional semantic memory retrieval', () => {
  it('requires exact opt-in even with a fake; rejects other regions and missing project config', () => {
    const embedder = fakeEmbedder();
    for (const disabled of [
      {},
      { [MEMORY_SEARCH_ENV]: 'false' },
      { [MEMORY_SEARCH_ENV]: '1' },
      { ...env, GCP_REGION: 'us-central1' },
    ]) {
      expect(createMemorySearch(disabled, { db, sessions, embedder })).toBeUndefined();
    }
    expect(createMemorySearch(env, { db, sessions })).toBeUndefined();
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('uses Firestore nearest neighbors, persists only vector metadata and reuses indexed memories', async () => {
    const f = await fixture('nearest');
    const football = await f.seed('football', 'サッカーがすき');
    await f.seed('swim', '水泳は土曜日');
    expect((await f.search(f.child, '蹴球'))?.[0]).toBe('サッカーがすき');
    expect(
      f.embedder.embed.mock.calls.filter(([, task]) => task === 'RETRIEVAL_DOCUMENT'),
    ).toHaveLength(2);
    const saved = (await football.get()).data()!;
    expect(saved['embedding']).toBeInstanceOf(VectorValue);
    expect((saved['embedding'] as VectorValue).toArray()).toHaveLength(768);
    expect(saved['embeddingModel']).toBe('fake-memory-768');
    expect(saved['embeddingContentHash']).toMatch(/^[a-f0-9]{64}$/);
    expect(saved).not.toHaveProperty('text');
    expect(JSON.stringify(saved)).not.toContain('サッカー');
    f.embedder.embed.mockClear();
    expect((await f.search(f.child, '蹴球'))?.[0]).toBe('サッカーがすき');
    expect(f.embedder.embed.mock.calls.map(([, task]) => task)).toEqual(['RETRIEVAL_QUERY']);
    expect(logs.join('\n')).not.toContain('サッカー');
  });

  it('does not embed pending proposals or unconsented, expired, revoked or mismatched memories', async () => {
    const f = await fixture('filters');
    await f.seed('valid', 'サッカーの練習');
    const invalid: Record<string, Record<string, unknown>> = {
      pending: { status: 'pending' },
      rejected: { status: 'rejected' },
      missingConsent: { consentedAt: null },
      expired: { expiresAt: new Date(0) },
      expireAlias: { expireAt: new Date(0) },
      deleted: { deletedAt: new Date() },
      deletedStatus: { status: 'deleted' },
      revoked: { revokedAt: new Date() },
      revokedStatus: { status: 'revoked' },
      otherPet: { petId: 'other' },
      missingPet: { petId: null },
      otherCharacter: { characterId: 'pokke' },
    };
    for (const [id, extra] of Object.entries(invalid)) await f.seed(id, `private-${id}`, extra);
    await db
      .doc(`${f.base}/memoryProposals/pending`)
      .set({ status: 'pending', contentEnc: Buffer.from('private-proposal') });
    expect(await f.search(f.child, '蹴球')).toEqual(['サッカーの練習']);
    expect(f.embedder.embed.mock.calls.map(([texts]) => texts)).toEqual([
      ['サッカーの練習'],
      ['蹴球'],
    ]);
    for (const id of Object.keys(invalid))
      expect((await f.collection.doc(id).get()).get('embedding')).toBeUndefined();
    expect(
      (await db.doc(`${f.base}/memoryProposals/pending`).get()).get('embedding'),
    ).toBeUndefined();
  });

  it('never indexes or returns a different child memory, even when its vector matches exactly', async () => {
    const a = await fixture('child-a');
    const b = await fixture('child-b');
    await a.seed('a', '水泳は土曜日');
    await b.seed('b', 'サッカーは秘密');
    await b.search(b.child, '蹴球');
    expect(await a.search(a.child, '蹴球')).toEqual(['水泳は土曜日']);
    expect(a.embedder.embed.mock.calls.flat(2)).not.toContain('サッカーは秘密');
  });

  it.each(['inactive', 'wrong-owner', 'pet-switched', 'pet-inactive', 'character-changed'])(
    'does not embed or write when current ownership is %s',
    async (reason) => {
      const f = await fixture(reason);
      const ref = await f.seed('a', 'サッカー');
      if (reason === 'inactive') await db.doc(f.base).update({ status: 'deleting' });
      if (reason === 'wrong-owner') await db.doc(f.base).update({ familyId: 'another-family' });
      if (reason === 'pet-switched') await db.doc(f.base).update({ activePetId: 'another-pet' });
      if (reason === 'pet-inactive')
        await db.doc(`${f.base}/pets/${f.child.petId}`).update({ active: false });
      if (reason === 'character-changed')
        await db.doc(`${f.base}/pets/${f.child.petId}`).update({ characterId: 'pokke' });
      expect(await f.search(f.child, '蹴球')).toEqual([]);
      expect(f.embedder.embed).not.toHaveBeenCalled();
      expect((await ref.get()).get('embedding')).toBeUndefined();
    },
  );

  it.each(['delete', 'revoke', 'replace', 'reset', 'deactivate'])(
    'rechecks after embedding and does not restore memory changed concurrently: %s',
    async (change) => {
      const f = await fixture(`race-${change}`);
      const ref = await f.seed('a', 'サッカーの古い記憶');
      const embed = f.embedder.embed.getMockImplementation()!;
      f.embedder.embed.mockImplementationOnce(async (texts, task) => {
        if (change === 'delete') await ref.delete();
        if (change === 'revoke') await ref.update({ revokedAt: new Date() });
        if (change === 'replace') await f.seed('a', '水泳の新しい記憶');
        if (change === 'reset')
          await db
            .doc(f.base)
            .update({ memoryRevision: FieldValue.increment(1), modelHistoryResetAt: new Date() });
        if (change === 'deactivate') await db.doc(f.base).update({ status: 'deleting' });
        return embed(texts, task);
      });
      expect(await f.search(f.child, '蹴球')).toEqual(
        change === 'reset' || change === 'deactivate' ? [] : undefined,
      );
      expect((await ref.get()).get('embedding')).toBeUndefined();
      if (change === 'delete') expect((await ref.get()).exists).toBe(false);
    },
  );

  it('physically removes a vector with the memory and cannot recall it again', async () => {
    const f = await fixture('delete-after-index');
    const ref = await f.seed('a', 'サッカー');
    expect(await f.search(f.child, '蹴球')).toEqual(['サッカー']);
    await ref.delete();
    expect(await f.search(f.child, '蹴球')).toBeUndefined();
    expect(await ref.listCollections()).toEqual([]);
  });

  it('rechecks after vector query so deletion or revocation during retrieval is not returned', async () => {
    const f = await fixture('query-race');
    const ref = await f.seed('a', 'サッカー');
    await f.search(f.child, '蹴球');
    const nearest = Query.prototype.findNearest;
    vi.spyOn(Query.prototype, 'findNearest').mockImplementation(function (this: Query, ...args) {
      const vectorQuery = nearest.apply(this, args);
      const get = vectorQuery.get.bind(vectorQuery);
      vi.spyOn(vectorQuery, 'get').mockImplementation(async () => {
        const result = await get();
        await ref.update({ status: 'revoked' });
        return result;
      });
      return vectorQuery;
    });
    expect(await f.search(f.child, '蹴球')).toBeUndefined();
  });

  it('bounds lazy backfill and uses only finite vectors of the required dimension', async () => {
    const f = await fixture('budget');
    for (let i = 0; i < agent.recallMaxMemories + 2; i++) await f.seed(String(i), 'サッカー');
    expect(await f.search(f.child, '蹴球')).toHaveLength(agent.recallMaxMemories);
    expect(
      f.embedder.embed.mock.calls.filter(([, task]) => task === 'RETRIEVAL_DOCUMENT'),
    ).toHaveLength(agent.recallMaxMemories);
    f.embedder.embed.mockResolvedValueOnce([[Number.NaN]]);
    expect(await f.search(f.child, '蹴球')).toBeUndefined();
  });

  it.each(['provider', 'index'])(
    'falls back to lexical retrieval when %s is unavailable without logging sensitive errors',
    async (kind) => {
      const f = await fixture(`failure-${kind}`);
      await f.seed('a', 'サッカーがすき');
      if (kind === 'provider')
        f.embedder.embed.mockRejectedValue(new Error('private-provider-text'));
      else
        vi.spyOn(Query.prototype, 'findNearest').mockImplementation(() => {
          throw new Error('private-index-text');
        });
      expect(await f.executor(f.search).recall(f.ctx, 'サッカー')).toEqual(['サッカーがすき']);
      expect(logs.join('\n')).not.toContain('private-provider-text');
      expect(logs.join('\n')).not.toContain('private-index-text');
    },
  );

  it('does not write a vector after an embedding call exceeds the shared first-token budget', async () => {
    const f = await fixture('timeout');
    const ref = await f.seed('a', 'サッカー');
    let release: (value: number[][]) => void = () => undefined;
    let started: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.embedder.embed.mockImplementationOnce(async () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const search = f.search(f.child, '蹴球');
    await pending;
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + agent.firstTokenTimeoutMs + 1);
    release([new Array<number>(768).fill(1)]);
    expect(await search).toBeUndefined();
    expect((await ref.get()).get('embedding')).toBeUndefined();
  });

  it('does not enqueue a vector update when the final transaction read exceeds the deadline', async () => {
    const f = await fixture('timeout-final-read');
    const ref = await f.seed('a', 'サッカー');
    const embed = f.embedder.embed.getMockImplementation()!;
    let embedded = false;
    f.embedder.embed.mockImplementation(async (texts, task) => {
      const result = await embed(texts, task);
      embedded = true;
      return result;
    });
    const get = Transaction.prototype.get;
    vi.spyOn(Transaction.prototype, 'get').mockImplementation(async function (
      this: Transaction,
      ...args
    ) {
      const snapshot = await get.apply(this, args);
      if (embedded && (args[0] as unknown as { path?: string }).path === ref.path) {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + agent.firstTokenTimeoutMs + 1);
      }
      return snapshot;
    });
    await f.search(f.child, '蹴球');
    expect((await ref.get()).get('embedding')).toBeUndefined();
  });

  it('does not start a write when a pending embedding resolves after the actual timeout returned', async () => {
    const f = await fixture('timeout-late-embedding');
    const ref = await f.seed('a', 'サッカー');
    let release: (value: number[][]) => void = () => undefined;
    let started: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.embedder.embed.mockImplementationOnce(async () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const update = vi.spyOn(Transaction.prototype, 'update');
    const result = f.search(f.child, '蹴球');
    await pending;
    expect(await result).toBeUndefined();
    release([new Array<number>(768).fill(1)]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(update).not.toHaveBeenCalled();
    expect((await ref.get()).get('embedding')).toBeUndefined();
  });
});

describe('executor memory search hook', () => {
  it('pseudonymizes semantic queries before embedding and shares the proposal privacy memo', async () => {
    const f = await fixture('executor-query-privacy');
    await f.seed('a', 'おともだちAくんとサッカーをする');
    const detectNames = vi.fn(async () => ['田中']);
    const executor = f.executor(f.search, detectNames);
    const topic = '田中くんとのサッカー';
    await executor.prepareMemory!(f.ctx, topic);
    expect(await executor.recall(f.ctx, topic)).toEqual(['おともだちAくんとサッカーをする']);
    expect(detectNames).toHaveBeenCalledTimes(1);
    expect(f.embedder.embed.mock.calls.at(-1)).toEqual([
      ['おともだちAくんとのサッカー'],
      'RETRIEVAL_QUERY',
    ]);
    expect(JSON.stringify(f.embedder.embed.mock.calls)).not.toContain('田中');
  });

  it('does not call embeddings when query pseudonymization fails', async () => {
    const f = await fixture('executor-query-privacy-failed');
    await f.seed('a', 'サッカーがすき');
    const hook = vi.fn(f.search);
    const executor = f.executor(hook, async () => {
      throw new Error('private-name-detector-error');
    });
    expect(await executor.recall(f.ctx, 'サッカー')).toEqual(['サッカーがすき']);
    expect(hook).not.toHaveBeenCalled();
    expect(f.embedder.embed).not.toHaveBeenCalled();
    expect(logs.join('\n')).not.toContain('private-name-detector-error');
  });

  it('preserves default lexical retrieval and treats an empty semantic result as authoritative', async () => {
    const f = await fixture('executor-default');
    await f.seed('a', 'サッカーがすき');
    expect(await f.executor().recall(f.ctx, 'サッカー')).toEqual(['サッカーがすき']);
    expect(await f.executor(async () => []).recall(f.ctx, 'サッカー')).toEqual([]);
    expect(await f.executor(async () => undefined).recall(f.ctx, 'サッカー')).toEqual([
      'サッカーがすき',
    ]);
    expect(
      await f
        .executor(async () => {
          throw new Error('private-hook');
        })
        .recall(f.ctx, 'サッカー'),
    ).toEqual(['サッカーがすき']);
    expect(logs.join('\n')).not.toContain('private-hook');
  });

  it('checks session and child identity before calling a hook and checks session again afterward', async () => {
    const f = await fixture('executor-auth');
    const hook = vi.fn(async () => ['サッカー']);
    await expect(f.executor(hook).recall({ ...f.ctx, childId: 'another' }, '蹴球')).rejects.toThrow(
      'context mismatch',
    );
    expect(hook).not.toHaveBeenCalled();
    hook.mockImplementationOnce(async () => {
      await db.doc(`${f.base}/sessions/${f.session.id}`).update({ endedAt: new Date() });
      return ['サッカー'];
    });
    await expect(f.executor(hook).recall(f.ctx, '蹴球')).rejects.toThrow(
      'session is not available',
    );
  });

  it('does not recall a revoked memory from the lexical fallback', async () => {
    const f = await fixture('executor-revoked');
    await f.seed('revoked', 'サッカー', { revokedAt: new Date() });
    await f.seed('status', 'サッカー', { status: 'revoked' });
    expect(await f.executor(async () => undefined).recall(f.ctx, 'サッカー')).toEqual([]);
  });

  it.each(['delete', 'revoke'])(
    'does not leak a concurrently %s memory through provider-error fallback',
    async (change) => {
      const f = await fixture(`fallback-${change}`);
      const ref = await f.seed('a', 'サッカー');
      f.embedder.embed.mockImplementationOnce(async () => {
        if (change === 'delete') await ref.delete();
        else await ref.update({ revokedAt: new Date() });
        throw new Error('private-provider-response');
      });
      expect(await f.executor(f.search).recall(f.ctx, 'サッカー')).toEqual([]);
      expect((await ref.get()).get('embedding')).toBeUndefined();
      expect(logs.join('\n')).not.toContain('private-provider-response');
    },
  );

  it('rechecks the current pet before lexical fallback after a provider failure', async () => {
    const f = await fixture('executor-switch');
    await f.seed('a', 'サッカー');
    const unavailable: MemorySearch = async () => {
      await db.doc(f.base).update({ activePetId: 'another-pet' });
      throw new Error('unavailable');
    };
    expect(await f.executor(unavailable).recall(f.ctx, 'サッカー')).toEqual([]);
  });
});
