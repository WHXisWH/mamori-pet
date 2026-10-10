import { AsyncLocalStorage } from 'node:async_hooks';

import type { CharacterId, GradeBand } from '@ijime/api-types';
import type { Firestore } from '@google-cloud/firestore';
import { dekCache } from '@ijime/config';
import { CachingKeyWrapper, EnvelopeCipher, LocalKeyWrapper, type KeyWrapper } from '@ijime/crypto';

export type ChildRecord = {
  childId: string;
  familyId: string;
  nickname: string;
  gradeBand: GradeBand;
  characterId: CharacterId;
  petId: string;
  petName: string;
  dek: Buffer;
};

export interface ChildDirectory {
  lookup(childId: string): Promise<ChildRecord | undefined>;
}

export function childPath(familyId: string, childId: string): string {
  return `families/${familyId}/children/${childId}`;
}

// child を読むたびに DEK をアンラップする必要がある。アンラップ結果はプロセス内に短時間キャッシュする（docs/03「概要と設計原則」第2項）
function withDekCache(wrapper: KeyWrapper): KeyWrapper {
  return wrapper instanceof CachingKeyWrapper
    ? wrapper
    : new CachingKeyWrapper(wrapper, { ttlMs: dekCache.ttlMs, maxEntries: dekCache.maxEntries });
}

const requestScope = new AsyncLocalStorage<Map<string, Promise<ChildRecord | undefined>>>();

// 1つのリクエストの中で実行する。その中では ScopedChildDirectory 経由の child の読み取りは1回だけ起きる
export function withChildScope<T>(fn: () => T): T {
  return requestScope.run(new Map(), fn);
}

// リクエストスコープの外（音声の常時接続、ジョブ）ではそのまま素通しする。リクエストをまたいで再利用せず、状態の変化は次のリクエストですぐに反映される。
// 読めたレコードだけを覚える。読めなかったもの（未作成、停止済み）は覚えないので、同じリクエスト内であとから作成したレコードも読める
export class ScopedChildDirectory implements ChildDirectory {
  constructor(private readonly inner: ChildDirectory) {}

  lookup(childId: string): Promise<ChildRecord | undefined> {
    const memo = requestScope.getStore();
    if (!memo) return this.inner.lookup(childId);
    let pending = memo.get(childId);
    if (!pending) {
      pending = this.inner.lookup(childId);
      memo.set(childId, pending);
      const settled = pending;
      void settled.then(
        (r) => {
          if (!r && memo.get(childId) === settled) memo.delete(childId);
        },
        () => {
          if (memo.get(childId) === settled) memo.delete(childId);
        },
      );
    }
    return pending;
  }
}

type ChildDoc = {
  status?: string;
  familyId: string;
  nickname: string;
  gradeBand: GradeBand;
  wrappedDek: Buffer | Uint8Array;
  activePetId?: string;
};

export class FirestoreChildDirectory implements ChildDirectory {
  private readonly cipher: EnvelopeCipher;

  constructor(
    private readonly db: Firestore,
    wrapper: KeyWrapper,
  ) {
    this.cipher = new EnvelopeCipher(withDekCache(wrapper));
  }

  async lookup(childId: string): Promise<ChildRecord | undefined> {
    const snap = await this.db
      .collectionGroup('children')
      .where('childId', '==', childId)
      .limit(1)
      .get();
    const doc = snap.docs[0];
    if (!doc) return undefined;
    const data = doc.data() as ChildDoc;
    if (data.status !== 'active') return undefined;
    const petSnap = await doc.ref.collection('pets').where('active', '==', true).limit(1).get();
    const pet = petSnap.docs[0];
    const petData = pet?.data() as { characterId: CharacterId; petName?: string } | undefined;
    const record: ChildRecord = {
      childId,
      familyId: data.familyId,
      nickname: data.nickname,
      gradeBand: data.gradeBand,
      characterId: petData?.characterId ?? 'moko',
      petId: pet?.id ?? 'none',
      petName: petData?.petName ?? '',
      dek: await this.cipher.unwrapChildKey(childId, Buffer.from(data.wrappedDek)),
    };
    return record;
  }
}

export class DevChildDirectory implements ChildDirectory {
  private readonly cipher: EnvelopeCipher;
  private readonly wrapper: KeyWrapper;

  constructor(
    private readonly db: Firestore,
    wrapper?: KeyWrapper,
    private readonly defaults: { gradeBand: GradeBand; characterId: CharacterId } = {
      gradeBand: 'high',
      characterId: 'moko',
    },
  ) {
    this.wrapper = withDekCache(wrapper ?? new LocalKeyWrapper(Buffer.alloc(32, 7)));
    this.cipher = new EnvelopeCipher(this.wrapper);
  }

  async lookup(childId: string): Promise<ChildRecord> {
    const familyId = `f_dev_${childId}`;
    const ref = this.db.doc(childPath(familyId, childId));
    const snap = await ref.get();
    let data = snap.data() as ChildDoc | undefined;
    if (!data) {
      const { wrappedDek } = await this.cipher.newChildKey(childId);
      data = {
        familyId,
        nickname: 'dev',
        gradeBand: this.defaults.gradeBand,
        wrappedDek,
      };
      await ref.set({
        ...data,
        childId,
        dataSources: {
          voice: true,
          typing: true,
          artwork_save: false,
          home_checkin: true,
          calendar: true,
        },
        currentRiskLevel: 'l0',
        careFlag: false,
        pseudoId: `p_dev_${childId}`,
        deviceLockEnabled: false,
        status: 'active',
        createdAt: new Date(),
      });
      await ref.collection('pets').doc('pet_dev').set({
        characterId: this.defaults.characterId,
        petName: '',
        active: true,
        createdAt: new Date(),
      });
    }
    const petSnap = await ref.collection('pets').where('active', '==', true).limit(1).get();
    const pet = petSnap.docs[0];
    const petData = pet?.data() as { characterId: CharacterId; petName?: string } | undefined;
    return {
      childId,
      familyId,
      nickname: data.nickname,
      gradeBand: data.gradeBand,
      characterId: petData?.characterId ?? this.defaults.characterId,
      petId: pet?.id ?? 'pet_dev',
      petName: petData?.petName ?? '',
      dek: await this.cipher.unwrapChildKey(childId, Buffer.from(data.wrappedDek)),
    };
  }
}

// Existing records (including paused/deleting children) always win over synthetic fixture creation.
export class LocalChildDirectory implements ChildDirectory {
  private readonly stored: FirestoreChildDirectory;
  private readonly fixtures: DevChildDirectory;

  constructor(
    private readonly db: Firestore,
    wrapper: KeyWrapper = new LocalKeyWrapper(Buffer.alloc(32, 7)),
  ) {
    const cached = withDekCache(wrapper);
    this.stored = new FirestoreChildDirectory(db, cached);
    this.fixtures = new DevChildDirectory(db, cached);
  }

  async lookup(childId: string): Promise<ChildRecord | undefined> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(childId)) return undefined;
    const existing = await this.db
      .collectionGroup('children')
      .where('childId', '==', childId)
      .limit(1)
      .get();
    if (!existing.empty) return this.stored.lookup(childId);
    return /^c_[a-zA-Z0-9_-]+$/.test(childId) ? this.fixtures.lookup(childId) : undefined;
  }
}
