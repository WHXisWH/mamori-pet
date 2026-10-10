import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  type FirestoreSessionService,
  PET_APP_NAME,
  petDemoScript,
  ScriptedLlm,
  type ChildDirectory,
} from '@ijime/agent-core';
import { LocalKeyWrapper, type KeyWrapper } from '@ijime/crypto';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createRuntime, type PetRuntime } from './runtime.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');

// KMS アンラップと child レコード読み取りの回数（受け入れ基準：テキスト会話1ターンで KMS は 1 回以下、同じリクエストでは child レコードを 1 回だけ読む）
class CountingWrapper implements KeyWrapper {
  unwraps = 0;
  private readonly inner = new LocalKeyWrapper(Buffer.alloc(32, 7));
  wrap(dek: Buffer, aad: Buffer) {
    return this.inner.wrap(dek, aad);
  }
  unwrap(wrapped: Buffer, aad: Buffer) {
    this.unwraps++;
    return this.inner.unwrap(wrapped, aad);
  }
}

let db: Firestore;
let runtime: PetRuntime;
let sessions: FirestoreSessionService;
const wrapper = new CountingWrapper();
let reads = 0;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-ijime-pet-cost-${process.pid}` });
  const inner = new DevChildDirectory(db, wrapper);
  const directory: ChildDirectory = {
    lookup: (childId) => {
      reads++;
      return inner.lookup(childId);
    },
  };
  // sessions は注入しない：runtime が本番と同じ方法で組み立てたセッションサービスを使う
  runtime = await createRuntime({
    kb: await Kb.load(new FsKbSource(KB_DIR)),
    db,
    directory,
    model: new ScriptedLlm(petDemoScript()),
    logger: new Logger('pet-agent', () => undefined),
  });
  sessions = runtime.sessions as FirestoreSessionService;
});

afterAll(() => db.terminate());

describe('request cost of one text turn', () => {
  it('reads the child record once and unwraps the DEK at most once', async () => {
    const childId = 'c_cost1';
    const s = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
    const { messageId } = await sessions.writeChildMessage(childId, s.id, {
      text: 'きょうは たのしかった！',
      inputMode: 'typed',
      crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
    });
    reads = 0;
    wrapper.unwraps = 0;
    const res = await createApp(async () => runtime).request('/internal/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId, sessionId: s.id, messageId }),
    });
    await res.text();
    expect(reads).toBe(1);
    expect(wrapper.unwraps).toBeLessThanOrEqual(1);
  });
});
