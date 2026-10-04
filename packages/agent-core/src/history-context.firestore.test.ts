import { randomUUID } from 'node:crypto';

import { FieldValue, Firestore, Query } from '@google-cloud/firestore';
import { Runner } from '@google/adk';
import { agent } from '@ijime/config';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPetAgent } from './agent.js';
import { DevChildDirectory } from './child-directory.js';
import { FirestoreSessionService, PET_APP_NAME } from './firestore-session.js';
import { ScriptedLlm } from './scripted-llm.js';

let db: Firestore;
const recentCount = agent.contextHistoryTurns * 2;

beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-history-${randomUUID().slice(0, 8)}` });
});
afterAll(() => db.terminate());

async function fixture(count = recentCount + 4) {
  const childId = `history_${randomUUID()}`;
  const directory = new DevChildDirectory(db);
  const child = await directory.lookup(childId);
  const svc = new FirestoreSessionService(db, directory, { writeUserEvents: false });
  const session = await svc.createSession({ appName: PET_APP_NAME, userId: childId });
  const base = `families/${child.familyId}/children/${childId}`;
  const path = `${base}/sessions/${session.id}`;
  const start = Date.now() - 100_000;
  const batch = db.batch();
  for (let i = 0; i < count; i++) {
    batch.set(db.doc(`${path}/messages/m${String(i).padStart(3, '0')}`), {
      role: i % 2 === 0 ? 'child' : 'pet',
      inputMode: i % 2 === 0 ? 'typed' : 'model',
      contentEnc: svc.encryptForChild(child, `utterance ${i}`, `${path}/messages#contentEnc`),
      createdAt: new Date(start + i),
      expireAt: new Date(Date.now() + 86_400_000),
    });
  }
  await batch.commit();
  const request = { appName: PET_APP_NAME, userId: childId, sessionId: session.id };
  return { child, svc, session, base, path, start, request };
}

describe('bounded history in the model request', () => {
  it('includes older role-labelled excerpts separately from recent events in actual ADK requests', async () => {
    const f = await fixture();
    const llm = new ScriptedLlm(() => ({ text: 'そっか。' }));
    const runner = new Runner({
      appName: PET_APP_NAME,
      agent: createPetAgent({ model: llm, instruction: 'authoritative charter', tools: [] }),
      sessionService: f.svc,
    });
    for await (const event of runner.runAsync({
      userId: f.child.childId,
      sessionId: f.session.id,
      newMessage: { role: 'user', parts: [{ text: 'current input' }] },
    })) {
      expect(event.errorCode).toBeUndefined();
    }
    const request = llm.requests[0]!;
    const summary = request.contents.find((c) =>
      c.parts?.some((p) => p.text?.includes('older_history_excerpt')),
    );
    expect(summary).toBeDefined();
    expect(summary!.role).toBe('user');
    const data = JSON.parse(summary!.parts![0]!.text!);
    expect(data).toMatchObject({
      kind: 'older_history_excerpt',
      untrusted: true,
      complete: false,
      method: 'extractive',
      excerpts: [
        { role: 'child', text: 'utterance 0' },
        { role: 'pet', text: 'utterance 1' },
        { role: 'child', text: 'utterance 2' },
        { role: 'pet', text: 'utterance 3' },
      ],
    });
    expect(JSON.stringify(request.config?.systemInstruction)).toContain('authoritative charter');
    expect(JSON.stringify(request.config?.systemInstruction)).not.toContain('utterance 0');
    expect(request.contents.flatMap((c) => c.parts ?? []).map((p) => p.text)).toContain(
      'utterance 4',
    );
    expect(JSON.stringify(request.contents.at(-1))).toContain('current input');
  });

  it('does not reconstruct pre-reset memory or tool outputs, and does not persist the summary', async () => {
    const f = await fixture();
    const messages = db.collection(`${f.path}/messages`);
    await messages.doc('m001').update({
      role: 'system',
      inputMode: 'tool',
      partsEnc: f.svc.encryptForChild(
        f.child,
        JSON.stringify({
          role: 'user',
          parts: [{ functionResponse: { name: 'recall', response: { text: 'deleted memory' } } }],
        }),
        `${f.path}/messages#partsEnc`,
      ),
    });
    const before = await f.svc.getSession(f.request);
    expect(before!.events).toHaveLength(recentCount + 1);
    expect(JSON.stringify(before!.events)).not.toContain('deleted memory');
    expect(await f.svc.getSession(f.request)).toEqual(before);
    expect((await messages.get()).size).toBe(recentCount + 4);
    expect((await db.doc(f.path).get()).get('adkState')).toEqual({});

    await db.doc(f.base).update({ modelHistoryResetAt: new Date(f.start + 2) });
    const reset = await f.svc.getSession({ ...f.request, config: { afterTimestamp: f.start } });
    expect(JSON.parse(reset!.events[0]!.content!.parts![0]!.text!).excerpts).toEqual([
      { role: 'pet', text: 'utterance 3', truncated: false },
    ]);
    expect(JSON.stringify(reset!.events)).not.toContain('deleted memory');
    const llm = new ScriptedLlm(() => ({ text: 'そっか。' }));
    const runner = new Runner({
      appName: PET_APP_NAME,
      agent: createPetAgent({ model: llm, instruction: 'authoritative charter', tools: [] }),
      sessionService: f.svc,
    });
    for await (const event of runner.runAsync({
      userId: f.child.childId,
      sessionId: f.session.id,
      newMessage: { role: 'user', parts: [{ text: 'after reset' }] },
    }))
      expect(event.errorCode).toBeUndefined();
    const requestData = JSON.stringify(llm.requests[0]);
    expect(requestData).not.toContain('deleted memory');
    const resetSummary = llm.requests[0]!.contents.find((c) =>
      c.parts?.some((p) => p.text?.includes('older_history_excerpt')),
    );
    expect(JSON.parse(resetSummary!.parts![0]!.text!).excerpts).toEqual([
      { role: 'pet', text: 'utterance 3', truncated: false },
    ]);
    // Remove the newly generated reply so the deletion assertion has the same window.
    const generated = (await messages.get()).docs.filter((d) => !/^m\d{3}$/.test(d.id));
    for (const message of generated) await message.ref.delete();
    await messages.doc('m003').delete();
    const deleted = await f.svc.getSession(f.request);
    expect(deleted!.events).toHaveLength(recentCount);
    expect(JSON.stringify(deleted!.events)).not.toContain('older_history_excerpt');
  });

  it('rejects stale child/pet ownership and expired sessions before returning history', async () => {
    const f = await fixture();
    const stale = new FirestoreSessionService(db, { lookup: async () => f.child });
    await db.doc(`${f.base}/pets/${f.child.petId}`).update({ active: false });
    expect(await stale.getSession(f.request)).toBeUndefined();
    await db.doc(`${f.base}/pets/${f.child.petId}`).update({ active: true });
    await db.doc(f.base).update({ activePetId: 'another_pet' });
    expect(await stale.getSession(f.request)).toBeUndefined();
    await db.doc(f.base).update({ activePetId: f.child.petId, status: 'deleting' });
    expect(await stale.getSession(f.request)).toBeUndefined();
    await db.doc(f.base).update({ status: 'active' });
    await db.doc(f.path).update({ expireAt: new Date(1) });
    expect(await stale.getSession(f.request)).toBeUndefined();
  });

  it('uses a single capped query without scanning past expired or corrupt messages', async () => {
    const f = await fixture(recentCount * 5);
    const limit = vi.spyOn(Query.prototype, 'limit');
    try {
      const loaded = await f.svc.getSession({ ...f.request, config: { numRecentEvents: 10000 } });
      expect(limit.mock.calls.map(([n]) => n)).toEqual([1, recentCount * 2]);
      expect(loaded!.events).toHaveLength(recentCount + 1);
      const summary = JSON.parse(loaded!.events[0]!.content!.parts![0]!.text!);
      expect(summary.excerpts[0].text).toBe(`utterance ${recentCount * 4 - 12}`);
      const batch = db.batch();
      for (let i = recentCount * 3; i < recentCount * 5; i++) {
        batch.update(db.doc(`${f.path}/messages/m${String(i).padStart(3, '0')}`), {
          expireAt: new Date(1),
        });
      }
      await batch.commit();
      limit.mockClear();
      expect((await f.svc.getSession(f.request))!.events).toEqual([]);
      expect(limit.mock.calls.map(([n]) => n)).toEqual([1, recentCount * 2]);
    } finally {
      limit.mockRestore();
    }
  });

  it('omits malformed, expired and tool-shaped older rows while preserving valid recent events', async () => {
    const f = await fixture(recentCount + 8);
    const update = (i: number, data: Record<string, unknown>) =>
      db.doc(`${f.path}/messages/m${String(i).padStart(3, '0')}`).update(data);
    await update(0, { expireAt: new Date(1) });
    await update(1, { contentEnc: Buffer.from('corrupt') });
    await update(2, { inputMode: 'tool' });
    await update(3, { role: 'system' });
    await update(4, { partsEnc: Buffer.from('corrupt tool parts') });
    await update(5, { role: 'administrator' });
    await update(6, { expireAt: 'invalid timestamp' });
    await update(8, { contentEnc: Buffer.from('corrupt recent') });
    const loaded = await f.svc.getSession(f.request);
    expect(loaded!.events).toHaveLength(recentCount);
    expect(JSON.parse(loaded!.events[0]!.content!.parts![0]!.text!).excerpts).toEqual([
      { role: 'pet', text: 'utterance 7', truncated: false },
    ]);
    expect(loaded!.events[1]!.content!.parts![0]!.text).toBe('utterance 9');
    await db.doc(f.base).update({ modelHistoryResetAt: 'not a timestamp' });
    expect(await f.svc.getSession(f.request)).toBeUndefined();
    await db.doc(f.base).update({ modelHistoryResetAt: FieldValue.delete() });
    await db.doc(f.path).update({ expireAt: FieldValue.delete() });
    expect(await f.svc.getSession(f.request)).toBeUndefined();
  });

  it('respects the later caller cutoff, same-timestamp resets and child/session isolation', async () => {
    const f = await fixture();
    await db.doc(f.base).update({ modelHistoryResetAt: new Date(f.start + 1) });
    const after = await f.svc.getSession({
      ...f.request,
      config: { afterTimestamp: f.start + 3, numRecentEvents: 10000 },
    });
    expect(after!.events).toHaveLength(recentCount);
    expect(after!.events[0]!.content!.parts![0]!.text).toBe('utterance 4');
    const other = await fixture(1);
    expect(await f.svc.getSession({ ...f.request, userId: other.child.childId })).toBeUndefined();
    await db.doc(f.path).update({ petId: 'different_pet' });
    expect(await f.svc.getSession(f.request)).toBeUndefined();
    await db.doc(f.path).delete();
    expect(await f.svc.getSession(f.request)).toBeUndefined();
  });

  it('honors a smaller requested recent window and never includes unsampled oldest history', async () => {
    const f = await fixture(recentCount * 3);
    const loaded = await f.svc.getSession({ ...f.request, config: { numRecentEvents: 2 } });
    expect(loaded!.events).toHaveLength(3);
    expect(loaded!.events.slice(1).map((e) => e.content!.parts![0]!.text)).toEqual([
      `utterance ${recentCount * 3 - 2}`,
      `utterance ${recentCount * 3 - 1}`,
    ]);
    const summary = JSON.parse(loaded!.events[0]!.content!.parts![0]!.text!);
    expect(summary.excerpts).toHaveLength(12);
    expect(summary.excerpts.at(-1).text).toBe(`utterance ${recentCount * 3 - 3}`);
    expect(JSON.stringify(summary)).not.toContain('utterance 0');
  });
});
