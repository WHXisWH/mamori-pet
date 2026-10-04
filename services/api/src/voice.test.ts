import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory } from '@ijime/agent-core';
import type { VoiceTicketRes } from '@ijime/api-types';
import { VOICE_TICKETS, tokenDigest } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { ChatDeps } from './chat.js';

let db: Firestore;
let app: ReturnType<typeof createApp>;
const H = (c: string) => ({ 'X-Dev-Child-Id': c });

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  const directory = new DevChildDirectory(db);
  await directory.lookup('c_voice_on');
  const off = await directory.lookup('c_voice_off');
  await db
    .doc(`families/${off!.familyId}/children/c_voice_off`)
    .set({ dataSources: { voice: false } }, { merge: true });
  app = createApp({
    getKb: async () => {
      throw new Error('unused');
    },
    allowedOrigins: [],
    chat: async () => ({ db, directory, auth: { allowDevHeader: true } }) as unknown as ChatDeps,
    voiceWsUrl: 'wss://voice.test/v1/voice',
  });
});
afterAll(() => db.terminate());

describe('POST /v1/child/voice/tickets', () => {
  it('requires a child', async () => {
    expect((await app.request('/v1/child/voice/tickets', { method: 'POST' })).status).toBe(401);
  });

  it('issues a single-use 60 second ticket bound to the child, storing only its digest', async () => {
    const before = Date.now();
    const res = await app.request('/v1/child/voice/tickets', {
      method: 'POST',
      headers: H('c_voice_on'),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as VoiceTicketRes;
    expect(body.wsUrl).toBe('wss://voice.test/v1/voice');
    const ttl = Date.parse(body.expiresAt) - before;
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
    const doc = (await db.collection(VOICE_TICKETS).doc(tokenDigest(body.ticket)).get()).data()!;
    expect(doc['childId']).toBe('c_voice_on');
    expect(JSON.stringify(doc)).not.toContain(body.ticket);
  });

  it('refuses when the child turned voice off', async () => {
    const res = await app.request('/v1/child/voice/tickets', {
      method: 'POST',
      headers: H('c_voice_off'),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'DATA_SOURCE_DISABLED',
    );
  });
});
