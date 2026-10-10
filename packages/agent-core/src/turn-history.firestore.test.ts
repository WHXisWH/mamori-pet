import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { createEvent } from '@google/adk';
import type { Content } from '@google/genai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPetAgent } from './agent.js';
import { DevChildDirectory } from './child-directory.js';
import { FirestoreSessionService, PET_APP_NAME } from './firestore-session.js';
import { OutputFilter } from './output-filter.js';
import { ScriptedLlm } from './scripted-llm.js';
import { runPetTurn } from './turn.js';

let db: Firestore;
let sessions: FirestoreSessionService;

beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-ijime-turn-history-${process.pid}` });
  sessions = new FirestoreSessionService(db, new DevChildDirectory(db), {
    writeUserEvents: false,
  });
});
afterAll(() => db.terminate());

async function fixture() {
  const childId = `c_history_${randomUUID()}`;
  const session = await sessions.createSession({ appName: PET_APP_NAME, userId: childId });
  const save = async (text: string) => {
    const { messageId } = await sessions.writeChildMessage(childId, session.id, {
      text,
      inputMode: 'typed',
      crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
    });
    return messageId;
  };
  const run = async (text: string, messageId?: string, fail = false) => {
    const requests: Content[][] = [];
    const model = new ScriptedLlm(() => {
      if (fail) throw new Error('model unavailable');
      return { text: 'いいね。' };
    });
    const generate = model.generateContentAsync.bind(model);
    model.generateContentAsync = async function* (request, stream) {
      requests.push(structuredClone(request.contents));
      yield* generate(request, stream);
    };
    const input = {
      agent: createPetAgent({ model, instruction: 'test', tools: [] }),
      sessionService: sessions,
      childId,
      sessionId: session.id,
      ...(messageId ? { messageId } : {}),
      text,
      gradeBand: 'high' as const,
      filter: new OutputFilter({ rules: [] }),
      safeReply: 'SAFE',
      actions: [],
    };
    const gen = runPetTurn(input);
    let result = await gen.next();
    while (!result.done) result = await gen.next();
    return { requests, outcome: result.value };
  };
  return { childId, session, save, run };
}

const inputs = (contents: Content[]) =>
  contents
    .filter((c) => c.role === 'user')
    .flatMap((c) => c.parts?.flatMap((p) => p.text ?? []) ?? []);

describe('persisted child input at the model request boundary', () => {
  it('presents an API-saved input exactly once without rewriting its database row', async () => {
    const { childId, session, save, run } = await fixture();
    const text = 'かみひこうきを つくったよ';
    const messageId = await save(text);
    const { requests, outcome } = await run(text, messageId);
    expect(outcome.fallback).toBeNull();
    expect(requests).toHaveLength(1);
    expect(inputs(requests[0]!)).toEqual([text]);
    const messages = await sessions.readMessages(childId, session.id);
    expect(messages.filter((m) => m.role === 'child')).toMatchObject([{ messageId, text }]);
  });

  it('presents the same saved input once on resume while retaining the prior fallback', async () => {
    const { childId, session, save, run } = await fixture();
    const text = 'いっしょに かみひこうきを つくろう';
    const messageId = await save(text);
    const failed = await run(text, messageId, true);
    expect(failed.outcome.fallback).toBe('SAFE');
    const resumed = await run(text, messageId);
    expect(resumed.outcome.fallback).toBeNull();
    expect(inputs(resumed.requests[0]!)).toEqual([text]);
    expect(
      resumed.requests[0]!.filter((c) => c.role === 'model').flatMap((c) => c.parts),
    ).toContainEqual({ text: 'SAFE' });
    expect(inputs(failed.requests[0]!)).toEqual([text]);
    expect(
      (await sessions.readMessages(childId, session.id)).filter((m) => m.role === 'child'),
    ).toHaveLength(1);
  });

  it('keeps identical text from a different message ID', async () => {
    const { save, run } = await fixture();
    const text = 'かみひこうきが すき';
    const previousId = await save(text);
    const currentId = await save(text);
    expect(previousId).not.toBe(currentId);
    const { requests } = await run(text, currentId);
    expect(inputs(requests[0]!)).toEqual([text, text]);
  });

  it('preserves signed tool call and response history without executing it again', async () => {
    const { childId, session, save, run } = await fixture();
    const call = {
      thoughtSignature: 'opaque-call-signature',
      functionCall: { id: 'call_old', name: 'recall', args: { topic: 'play' } },
    };
    const response = {
      functionResponse: { id: 'call_old', name: 'recall', response: { memories: [] } },
    };
    for (const [index, part] of [call, response].entries()) {
      await sessions.appendEvent({
        session,
        event: createEvent({
          id: `tool_${index}`,
          invocationId: 'previous_invocation',
          author: index === 0 ? 'pet_agent' : 'user',
          content: { role: index === 0 ? 'model' : 'user', parts: [part] },
        }),
      });
    }
    const text = 'あそぼう';
    const messageId = await save(text);
    const { requests, outcome } = await run(text, messageId);
    expect(outcome.toolCalls).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.flatMap((c) => c.parts)).toEqual(expect.arrayContaining([call, response]));
    expect(inputs(requests[0]!)).toEqual([text]);
    const reloaded = await sessions.getSession({
      appName: PET_APP_NAME,
      userId: childId,
      sessionId: session.id,
    });
    expect(reloaded!.events.filter((e) => e.id.startsWith('tool_')).map((e) => e.id)).toEqual([
      'tool_0',
      'tool_1',
    ]);
  });

  it('keeps the existing path for unsaved inputs without a message ID', async () => {
    const { save, run } = await fixture();
    const text = 'おはよう';
    await save(text);
    const { requests } = await run(text);
    expect(inputs(requests[0]!)).toEqual([text, text]);
  });
});
