import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  PET_APP_NAME,
  ScriptedLlm,
} from '@ijime/agent-core';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createRuntime, type PetRuntime } from './runtime.js';

let db: Firestore;
let rt: PetRuntime;
const logs: string[] = [];
const model = new ScriptedLlm(() => ({ text: 'はなしてくれて ありがとう。' }));

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-memory-context-${process.pid}` });
  const directory = new DevChildDirectory(db);
  rt = await createRuntime({
    db,
    directory,
    model,
    sessions: new FirestoreSessionService(db, directory, { writeUserEvents: false }),
    kb: await Kb.load(
      new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
    ),
    logger: new Logger('memory-context-test', (line) => logs.push(line)),
  });
});
afterAll(() => db.terminate());

async function ask(childId: string, text: string) {
  const session = await rt.sessions.createSession({ appName: PET_APP_NAME, userId: childId });
  const { messageId } = await rt.sessions.writeChildMessage(childId, session.id, {
    text,
    inputMode: 'typed',
    crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
  });
  const first = model.requests.length;
  const res = await createApp(async () => rt).request('/internal/turns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ childId, sessionId: session.id, messageId }),
  });
  expect(res.status).toBe(200);
  await res.text();
  expect(model.requests.length).toBeGreaterThan(first);
  return JSON.stringify(model.requests[first]!.config?.systemInstruction);
}

describe('consented memory prefetch into the real agent instruction', () => {
  it('includes only relevant consented current-pet memories, and forgets on the next turn', async () => {
    const childId = 'c_memory_context';
    const child = (await rt.directory.lookup(childId))!;
    const path = `families/${child.familyId}/children/${childId}/memories`;
    const fixtures = {
      accepted: { text: 'サッカーの練習は火曜日', consentedAt: new Date() },
      pending: { text: 'サッカーの候補は未確認', status: 'pending' },
      rejected: { text: 'サッカーの候補は拒否', status: 'rejected', consentedAt: new Date() },
      expired: { text: 'サッカーの期限切れ', consentedAt: new Date(), expiresAt: new Date(0) },
      deleted: { text: 'サッカーの削除済み', consentedAt: new Date(), deletedAt: new Date() },
      otherCharacter: { text: 'サッカーの別キャラ', consentedAt: new Date(), characterId: 'pokke' },
      otherPet: { text: 'サッカーの別の相棒', consentedAt: new Date(), petId: 'p_other' },
      unrelated: { text: '水泳は土曜日', consentedAt: new Date() },
    };
    for (const [id, { text, ...extra }] of Object.entries(fixtures)) {
      await db.doc(`${path}/${id}`).set({
        category: 'event',
        characterId: child.characterId,
        petId: child.petId,
        contentEnc: rt.sessions.encryptForChild(child, text, `${path}#contentEnc`),
        createdAt: new Date(),
        ...extra,
      });
    }
    const instruction = await ask(childId, 'サッカー');
    expect(instruction).toContain(fixtures.accepted.text);
    for (const [id, value] of Object.entries(fixtures)) {
      if (id !== 'accepted') expect(instruction).not.toContain(value.text);
    }
    expect(await ask(childId, '音楽')).not.toContain(fixtures.accepted.text);
    await db.doc(`${path}/accepted`).delete();
    expect(await ask(childId, 'サッカー')).not.toContain(fixtures.accepted.text);
    expect(logs.join('\n')).not.toContain(fixtures.accepted.text);
  });
});
