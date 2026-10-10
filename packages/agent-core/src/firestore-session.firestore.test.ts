import { Firestore } from '@google-cloud/firestore';
import { createEvent } from '@google/adk';
import { agent } from '@ijime/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalKeyWrapper } from '@ijime/crypto';
import { DevChildDirectory, FirestoreChildDirectory } from './child-directory.js';
import { FirestoreSessionService, PET_APP_NAME } from './firestore-session.js';

let db: Firestore;
let svc: FirestoreSessionService;

beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-ijime-core-tests-${process.pid}` });
  svc = new FirestoreSessionService(db, new DevChildDirectory(db));
});

afterAll(() => db.terminate());

describe('FirestoreSessionService', () => {
  it('creates a session document under the child and lists it', async () => {
    const s = await svc.createSession({
      appName: PET_APP_NAME,
      userId: 'c_t1',
      state: { channel: 'text' },
    });
    const doc = await db.doc(`families/f_dev_c_t1/children/c_t1/sessions/${s.id}`).get();
    expect(doc.exists).toBe(true);
    expect(doc.data()).toMatchObject({
      channel: 'text',
      turnCount: 0,
      safeMode: false,
      petId: 'pet_dev',
    });
    const list = await svc.listSessions({ appName: PET_APP_NAME, userId: 'c_t1' });
    expect(list.sessions.map((x) => x.id)).toContain(s.id);
  });

  it('stores messages encrypted and rebuilds ADK events in order', async () => {
    const s = await svc.createSession({ appName: PET_APP_NAME, userId: 'c_t2' });
    const { messageId } = await svc.writeChildMessage('c_t2', s.id, {
      text: 'きょう、みんなに むしされた',
      inputMode: 'typed',
      typing: { keyCount: 10, deleteCount: 2, composeMs: 4000, longPauseCount: 0 },
      crisisCheck: { hit: false, method: 'keyword', score: 0, checkedAt: new Date() },
    });
    const raw = (
      await db.doc(`families/f_dev_c_t2/children/c_t2/sessions/${s.id}/messages/${messageId}`).get()
    ).data()!;
    expect(Buffer.from(raw['contentEnc']).toString('utf8')).not.toContain('むしされた');
    expect(raw['typing']).toEqual({
      keyCount: 10,
      deleteCount: 2,
      composeMs: 4000,
      longPauseCount: 0,
    });
    expect(raw['role']).toBe('child');

    const session = (await svc.getSession({
      appName: PET_APP_NAME,
      userId: 'c_t2',
      sessionId: s.id,
    }))!;
    await new Promise((r) => setTimeout(r, 5));
    await svc.appendEvent({
      session,
      event: createEvent({
        author: 'pet_agent',
        invocationId: 'inv_1',
        content: { role: 'model', parts: [{ text: 'そっか…それは つらかったね。' }] },
      }),
    });
    const reloaded = (await svc.getSession({
      appName: PET_APP_NAME,
      userId: 'c_t2',
      sessionId: s.id,
    }))!;
    expect(reloaded.events.map((e) => e.content?.role)).toEqual(['user', 'model']);
    expect(reloaded.events[0]?.content?.parts?.[0]?.text).toBe('きょう、みんなに むしされた');
    const sessionDoc = (
      await db.doc(`families/f_dev_c_t2/children/c_t2/sessions/${s.id}`).get()
    ).data()!;
    expect(sessionDoc['turnCount']).toBe(1);

    const msgs = await svc.readMessages('c_t2', s.id);
    expect(msgs.map((m) => m.role)).toEqual(['child', 'pet']);
    expect(msgs[1]?.text).toBe('そっか…それは つらかったね。');
  });

  it('keeps messages awaiting crisis recheck out of the model history until cleared', async () => {
    const s = await svc.createSession({ appName: PET_APP_NAME, userId: 'c_t_pending' });
    await svc.writeChildMessage('c_t_pending', s.id, {
      text: 'まえの はなし',
      inputMode: 'typed',
      crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
    });
    await new Promise((r) => setTimeout(r, 5));
    const { messageId } = await svc.writeChildMessage('c_t_pending', s.id, {
      text: 'まだ しらべてない',
      inputMode: 'typed',
      crisisCheck: {
        hit: false,
        method: 'paused',
        score: 0,
        checkedAt: new Date(),
        pendingReview: true,
      },
    });
    const history = async () =>
      (await svc.getSession({
        appName: PET_APP_NAME,
        userId: 'c_t_pending',
        sessionId: s.id,
      }))!.events.map((e) => e.content?.parts?.[0]?.text);
    expect(await history()).toEqual(['まえの はなし']);
    expect((await svc.readMessages('c_t_pending', s.id)).map((m) => m.text)).toEqual([
      'まえの はなし',
      'まだ しらべてない',
    ]);
    await db
      .doc(`families/f_dev_c_t_pending/children/c_t_pending/sessions/${s.id}/messages/${messageId}`)
      .update({ 'crisisCheck.pendingReview': false });
    expect(await history()).toEqual(['まえの はなし', 'まだ しらべてない']);
  });

  it('skips writing user events when the api owns child messages, keeps tool events as system', async () => {
    const owned = new FirestoreSessionService(db, new DevChildDirectory(db), {
      writeUserEvents: false,
    });
    const s = await owned.createSession({ appName: PET_APP_NAME, userId: 'c_t3' });
    const session = (await owned.getSession({
      appName: PET_APP_NAME,
      userId: 'c_t3',
      sessionId: s.id,
    }))!;
    await owned.appendEvent({
      session,
      event: createEvent({ author: 'user', content: { role: 'user', parts: [{ text: 'やあ' }] } }),
    });
    await owned.appendEvent({
      session,
      event: createEvent({
        author: 'pet_agent',
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'set_expression', args: { expression: 'happy' } } }],
        },
      }),
    });
    await owned.appendEvent({
      session,
      event: createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{ functionResponse: { name: 'set_expression', response: { ok: true } } }],
        },
      }),
    });
    const snap = await db
      .collection(`families/f_dev_c_t3/children/c_t3/sessions/${s.id}/messages`)
      .get();
    expect(snap.docs.map((d) => d.data()['role']).sort()).toEqual(['system', 'system']);
    const reloaded = (await owned.getSession({
      appName: PET_APP_NAME,
      userId: 'c_t3',
      sessionId: s.id,
    }))!;
    expect(reloaded.events[0]?.content?.parts?.[0]?.functionCall?.name).toBe('set_expression');
    expect(reloaded.events[1]?.content?.parts?.[0]?.functionResponse?.name).toBe('set_expression');
    expect((await owned.readMessages('c_t3', s.id)).length).toBe(0);
  });

  it('omits thought text from encrypted replies, UI history and model history', async () => {
    const childId = 'c_thought_text';
    const session = await svc.createSession({ appName: PET_APP_NAME, userId: childId });
    const path = `families/f_dev_${childId}/children/${childId}/sessions/${session.id}`;
    const child = await new DevChildDirectory(db).lookup(childId);
    await svc.appendEvent({
      session,
      event: createEvent({
        id: 'thought_only',
        author: 'pet_agent',
        timestamp: 1000,
        content: { role: 'model', parts: [{ thought: true, text: 'PRIVATE_THOUGHT_ONLY' }] },
      }),
    });
    const event = createEvent({
      id: 'visible_reply',
      author: 'pet_agent',
      timestamp: 2000,
      content: {
        role: 'model',
        parts: [{ thought: true, text: 'PRIVATE_THOUGHT' }, { text: 'Visible reply.' }],
      },
    });
    await svc.appendEvent({ session, event });
    const raw = (await db.doc(`${path}/messages/${event.id}`).get()).data()!;
    expect(
      svc.decryptForChild(child, Buffer.from(raw['contentEnc']), `${path}/messages#contentEnc`),
    ).toBe('Visible reply.');
    expect((await db.doc(`${path}/messages/thought_only`).get()).exists).toBe(false);
    expect((await db.doc(path).get()).get('turnCount')).toBe(1);
    expect(JSON.stringify(session.events)).not.toContain('PRIVATE_THOUGHT');
    expect(event.content!.parts![0]!.text).toBe('PRIVATE_THOUGHT');
    expect((await svc.readMessages(childId, session.id)).map((m) => m.text)).toEqual([
      'Visible reply.',
    ]);
    expect((await svc.readMessageContext(childId, session.id, event.id, 1))?.message.text).toBe(
      'Visible reply.',
    );
    const recent = await svc.getSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId: session.id,
    });
    expect(recent!.events.map((e) => e.content?.parts)).toEqual([[{ text: 'Visible reply.' }]]);

    const { messageId } = await svc.writeChildMessage(childId, session.id, {
      text: 'New message.',
      inputMode: 'typed',
      crisisCheck: undefined,
    });
    expect((await svc.readMessageContext(childId, session.id, messageId, 1))?.prior).toEqual([
      { role: 'pet', text: 'Visible reply.' },
    ]);
    const history = await svc.getSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId: session.id,
      config: { numRecentEvents: 1 },
    });
    expect(history!.events[0]!.content!.parts![0]!.text).toContain('older_history_excerpt');
    expect(history!.events[0]!.content!.parts![0]!.text).toContain('Visible reply.');
    expect(JSON.stringify(history!.events)).not.toContain('PRIVATE_THOUGHT');
  });

  it('removes thought text while preserving signed function parts and their nested payloads', async () => {
    const childId = 'c_thought_tools';
    const session = await svc.createSession({ appName: PET_APP_NAME, userId: childId });
    const path = `families/f_dev_${childId}/children/${childId}/sessions/${session.id}/messages`;
    const child = await new DevChildDirectory(db).lookup(childId);
    const functionParts = [
      {
        thought: true,
        thoughtSignature: 'opaque-call-signature',
        functionCall: {
          id: 'call_1',
          name: 'recall',
          args: { topic: 'school', text: 'Keep argument text.' },
        },
      },
      {
        thought: true,
        thoughtSignature: 'opaque-response-signature',
        functionResponse: {
          id: 'call_1',
          name: 'recall',
          response: { text: 'Keep response text.', thought: true, memories: ['school'] },
        },
      },
    ];
    const signaturePart = { thought: true, thoughtSignature: 'opaque-standalone-signature' };
    for (const [index, functionPart] of functionParts.entries()) {
      const role = index === 0 ? 'model' : 'user';
      const originalContent = {
        role,
        parts: [
          { thought: true, text: 'PRIVATE_THOUGHT_SEPARATE' },
          { ...functionPart, text: 'PRIVATE_THOUGHT_FUNCTION' },
          signaturePart,
        ],
      };
      const event = createEvent({
        author: index === 0 ? 'pet_agent' : 'user',
        timestamp: 1000 + index,
        content: originalContent,
      });
      await svc.appendEvent({ session, event });
      const raw = (await db.doc(`${path}/${event.id}`).get()).data()!;
      expect(raw['role']).toBe('system');
      expect(svc.decryptForChild(child, Buffer.from(raw['contentEnc']), `${path}#contentEnc`)).toBe(
        '',
      );
      const expectedContent = { role, parts: [functionPart, signaturePart] };
      expect(
        JSON.parse(svc.decryptForChild(child, Buffer.from(raw['partsEnc']), `${path}#partsEnc`)),
      ).toEqual(expectedContent);
      expect(session.events.at(-1)!.content).toEqual(expectedContent);
      expect(event.content).toEqual(originalContent);
      const loaded = await svc.getSession({
        appName: PET_APP_NAME,
        userId: childId,
        sessionId: session.id,
      });
      expect(loaded!.events.find((e) => e.id === event.id)!.content).toEqual(expectedContent);

      // Older tool rows still have part metadata, so thoughts can also be removed on read.
      await db.doc(`${path}/${event.id}`).update({
        partsEnc: svc.encryptForChild(child, JSON.stringify(originalContent), `${path}#partsEnc`),
      });
      const legacy = await svc.getSession({
        appName: PET_APP_NAME,
        userId: childId,
        sessionId: session.id,
      });
      expect(legacy!.events.find((e) => e.id === event.id)!.content).toEqual(expectedContent);
      expect(JSON.stringify(legacy!.events)).not.toContain('PRIVATE_THOUGHT');
    }
    expect(await svc.readMessages(childId, session.id)).toEqual([]);
  });

  it('persists state deltas, safe mode and deletes recursively', async () => {
    const s = await svc.createSession({ appName: PET_APP_NAME, userId: 'c_t4' });
    const session = (await svc.getSession({
      appName: PET_APP_NAME,
      userId: 'c_t4',
      sessionId: s.id,
    }))!;
    await svc.appendEvent({
      session,
      event: createEvent({
        author: 'pet_agent',
        content: { role: 'model', parts: [{ text: 'ok。' }] },
        actions: { stateDelta: { careFlag: true } },
      }),
    });
    await svc.markSafeMode('c_t4', s.id);
    const doc = (await db.doc(`families/f_dev_c_t4/children/c_t4/sessions/${s.id}`).get()).data()!;
    expect(doc['adkState']).toEqual({ careFlag: true });
    expect(doc['safeMode']).toBe(true);
    await svc.deleteSession({ appName: PET_APP_NAME, userId: 'c_t4', sessionId: s.id });
    expect(
      await svc.getSession({ appName: PET_APP_NAME, userId: 'c_t4', sessionId: s.id }),
    ).toBeUndefined();
    expect(
      (await db.collection(`families/f_dev_c_t4/children/c_t4/sessions/${s.id}/messages`).get())
        .size,
    ).toBe(0);
  });

  it('bounds and orders history before decrypting, even when a caller asks for all events', async () => {
    const childId = 'c_bounded';
    const s = await svc.createSession({ appName: PET_APP_NAME, userId: childId });
    const count = agent.contextHistoryTurns * 2 + 10;
    const base = `families/f_dev_${childId}/children/${childId}/sessions/${s.id}/messages`;
    const directory = new DevChildDirectory(db);
    const child = await directory.lookup(childId);
    const batch = db.batch();
    for (let i = 0; i < count; i += 1)
      batch.set(db.doc(`${base}/m${String(i).padStart(3, '0')}`), {
        role: i % 2 === 0 ? 'child' : 'pet',
        inputMode: 'typed',
        contentEnc: svc.encryptForChild(child, `turn ${i}`, `${base}#contentEnc`),
        createdAt: new Date(1_000 + i),
        expireAt: new Date(Date.now() + 86_400_000),
      });
    await batch.commit();
    const loaded = await svc.getSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId: s.id,
      config: { numRecentEvents: 10000 },
    });
    expect(loaded!.events).toHaveLength(agent.contextHistoryTurns * 2 + 1);
    expect(loaded!.events[0]!.content!.parts![0]!.text).toContain('older_history_excerpt');
    expect(loaded!.events[1]!.content!.parts![0]!.text).toBe('turn 10');
    expect(loaded!.events.at(-1)!.content!.parts![0]!.text).toBe(`turn ${count - 1}`);
  });

  it('rejects a stale child record after deletion starts without recreating messages or state', async () => {
    const childId = 'c_delete_race';
    const session = await svc.createSession({ appName: PET_APP_NAME, userId: childId });
    const cachedChild = await new DevChildDirectory(db).lookup(childId);
    const base = `families/${cachedChild.familyId}/children/${childId}`;
    const path = `${base}/sessions/${session.id}`;
    const stale = new FirestoreSessionService(db, { lookup: async () => cachedChild });
    await db.doc(base).update({ status: 'deleting' });
    const input = { text: 'must not return', inputMode: 'typed' as const, crisisCheck: undefined };
    await expect(stale.writeChildMessage(childId, session.id, input)).rejects.toThrow(
      'child_not_active',
    );
    await expect(
      stale.appendEvent({
        session,
        event: createEvent({
          author: 'pet_agent',
          content: { role: 'model', parts: [{ text: 'must not return' }] },
          actions: { stateDelta: { unapproved: 'must not return' } },
        }),
      }),
    ).rejects.toThrow('child_not_active');
    await expect(stale.writePetTranscript(childId, session.id, 'must not return')).rejects.toThrow(
      'child_not_active',
    );
    await expect(stale.createSession({ appName: PET_APP_NAME, userId: childId })).rejects.toThrow(
      'child_not_active',
    );
    expect((await db.collection(`${path}/messages`).get()).empty).toBe(true);
    expect((await db.doc(path).get()).get('adkState')).toEqual({});
    expect(session.events).toEqual([]);
    await db.recursiveDelete(db.doc(base));
    await expect(stale.writeChildMessage(childId, session.id, input)).rejects.toThrow(
      'child_not_active',
    );
    await expect(
      stale.appendEvent({
        session,
        event: createEvent({
          author: 'pet_agent',
          content: { role: 'model', parts: [{ text: 'must not return' }] },
        }),
      }),
    ).rejects.toThrow('child_not_active');
    expect((await db.doc(base).get()).exists).toBe(false);
    expect((await db.collection(`${path}/messages`).get()).empty).toBe(true);
  });

  it('rejects missing sessions even while the child remains active', async () => {
    const childId = 'c_deleted_session';
    const session = await svc.createSession({ appName: PET_APP_NAME, userId: childId });
    const path = `families/f_dev_${childId}/children/${childId}/sessions/${session.id}`;
    await db.recursiveDelete(db.doc(path));
    await expect(
      svc.writeChildMessage(childId, session.id, {
        text: 'late request',
        inputMode: 'typed',
        crisisCheck: undefined,
      }),
    ).rejects.toThrow('session_not_found');
    await expect(
      svc.appendEvent({
        session,
        event: createEvent({
          author: 'pet_agent',
          content: { role: 'model', parts: [{ text: 'late response' }] },
        }),
      }),
    ).rejects.toThrow('session_not_found');
    expect((await db.doc(path).get()).exists).toBe(false);
    expect((await db.collection(`${path}/messages`).get()).empty).toBe(true);
  });

  it('omits old recall results from model history after reset but leaves UI chat history intact', async () => {
    const childId = 'c_memory_history_reset';
    const session = await svc.createSession({ appName: PET_APP_NAME, userId: childId });
    const base = `families/f_dev_${childId}/children/${childId}`;
    await svc.appendEvent({
      session,
      event: createEvent({
        author: 'pet_agent',
        timestamp: 1000,
        content: { role: 'model', parts: [{ text: 'visible previous conversation' }] },
      }),
    });
    await svc.appendEvent({
      session,
      event: createEvent({
        author: 'user',
        timestamp: 2000,
        content: {
          role: 'user',
          parts: [
            { functionResponse: { name: 'recall', response: { memories: ['forgotten memory'] } } },
          ],
        },
      }),
    });
    await svc.appendEvent({
      session,
      event: createEvent({
        author: 'user',
        timestamp: 3000,
        content: { role: 'user', parts: [{ text: 'at the cutoff' }] },
      }),
    });
    await svc.appendEvent({
      session,
      event: createEvent({
        author: 'user',
        timestamp: 4000,
        content: { role: 'user', parts: [{ text: 'fresh conversation' }] },
      }),
    });
    await db.doc(base).update({ modelHistoryResetAt: new Date(3000) });
    const loaded = await svc.getSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId: session.id,
      config: { afterTimestamp: 1000 },
    });
    expect(loaded!.events.map((e) => e.content!.parts![0]!.text)).toEqual(['fresh conversation']);
    expect(JSON.stringify(loaded!.events)).not.toMatch(/forgotten memory|at the cutoff/);
    const uiHistory = await svc.readMessages(childId, session.id);
    expect(uiHistory.map((m) => m.text)).toEqual([
      'visible previous conversation',
      'at the cutoff',
      'fresh conversation',
    ]);
  });

  it('production directory rejects nonactive children instead of returning a stale record', async () => {
    const childId = 'c_directory_revoke';
    await new DevChildDirectory(db).lookup(childId);
    const directory = new FirestoreChildDirectory(db, new LocalKeyWrapper(Buffer.alloc(32, 7)));
    expect((await directory.lookup(childId))?.childId).toBe(childId);
    await db.doc(`families/f_dev_${childId}/children/${childId}`).update({ status: 'deleting' });
    expect(await directory.lookup(childId)).toBeUndefined();
  });
});
