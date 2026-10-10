import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  petDemoScript,
  ScriptedLlm,
  type ChildDirectory,
} from '@ijime/agent-core';
import { LocalKeyWrapper, type KeyWrapper } from '@ijime/crypto';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { createApp as createPetAgentApp } from '@ijime/pet-agent/src/app.js';
import { createRuntime as createPetRuntime } from '@ijime/pet-agent/src/runtime.js';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { AppPetAgentClient } from './pet-agent-client.js';
import { createApiRuntime } from './runtime.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const CHILD = 'c_cost_api';
const H = { 'Content-Type': 'application/json', 'X-Dev-Child-Id': CHILD };

// プロセスごとの child 読み取り回数と KMS アンラップ回数（受け入れ基準）
class Counter implements KeyWrapper {
  unwraps = 0;
  reads = 0;
  private readonly inner = new LocalKeyWrapper(Buffer.alloc(32, 7));
  wrap(dek: Buffer, aad: Buffer) {
    return this.inner.wrap(dek, aad);
  }
  unwrap(wrapped: Buffer, aad: Buffer) {
    this.unwraps++;
    return this.inner.unwrap(wrapped, aad);
  }
  directory(db: Firestore): ChildDirectory {
    const inner = new DevChildDirectory(db, this);
    return {
      lookup: (id) => {
        this.reads++;
        return inner.lookup(id);
      },
    };
  }
}

let db: Firestore;
let app: ReturnType<typeof createApp>;
const api = new Counter();
const pet = new Counter();

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-ijime-api-cost-${process.pid}` });
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  const petRuntime = await createPetRuntime({
    kb,
    db,
    directory: pet.directory(db),
    model: new ScriptedLlm(petDemoScript()),
    logger: new Logger('pet-agent', () => undefined),
  });
  const rt = await createApiRuntime({
    kb,
    db,
    directory: api.directory(db),
    petAgent: new AppPetAgentClient(createPetAgentApp(async () => petRuntime) as never),
    logger: new Logger('api', () => undefined),
    publish: async () => {},
    auth: { allowDevHeader: true },
  });
  app = createApp({
    getKb: async () => kb,
    allowedOrigins: ['http://localhost:3000'],
    chat: async () => rt.chat,
  });
});

afterAll(() => db.terminate());

describe('request cost of one text turn through the api', () => {
  it('each process reads the child once per request; warm DEK caches make no KMS call', async () => {
    const start = await app.request('/v1/child/chat/sessions', {
      method: 'POST',
      headers: H,
      body: '{}',
    });
    const { sessionId } = (await start.json()) as { sessionId: string };
    const send = async () => {
      const res = await app.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          text: 'きょうは たのしかった！',
          inputMode: 'typed',
          clientSentAt: new Date().toISOString(),
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
    };

    for (const c of [api, pet]) c.reads = c.unwraps = 0;
    await send();
    expect({ apiReads: api.reads, petReads: pet.reads }).toEqual({ apiReads: 1, petReads: 1 });
    // セッション作成時に api 側ではすでにアンラップ済み。pet-agent はこのターンが初回
    expect({ apiKms: api.unwraps, petKms: pet.unwraps }).toEqual({ apiKms: 0, petKms: 1 });

    for (const c of [api, pet]) c.reads = c.unwraps = 0;
    await send();
    expect({ apiKms: api.unwraps, petKms: pet.unwraps }).toEqual({ apiKms: 0, petKms: 0 });
  });
});
