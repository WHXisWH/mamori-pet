import { Firestore } from '@google-cloud/firestore';
import {
  BUDGETED_TOOLS,
  DevChildDirectory,
  FirestoreSessionService,
  PET_APP_NAME,
  type PetToolName,
} from '@ijime/agent-core';
import { agent } from '@ijime/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reserveHttpToolCall } from './executor.js';

let db: Firestore;
let directory: DevChildDirectory;
let sessions: FirestoreSessionService;
beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-http-budget-${process.pid}` });
  directory = new DevChildDirectory(db);
  sessions = new FirestoreSessionService(db, directory);
});
afterAll(() => db.terminate());

describe('HTTP business tool budget', () => {
  it('only counts business tools; actions and safety remain free before and after exhaustion', async () => {
    const child = await directory.lookup('c_budget_http');
    const session = await sessions.createSession({ appName: PET_APP_NAME, userId: child.childId });
    const ctx = {
      childId: child.childId,
      sessionId: session.id,
      gradeBand: child.gradeBand,
      characterId: child.characterId,
      operationId: 'turn-1',
    };
    const free: PetToolName[] = [
      'set_expression',
      'offer_quick_replies',
      'show_help_resources',
      'start_tell_adult',
      'escalate_crisis',
    ];
    for (const name of free) {
      expect(BUDGETED_TOOLS.has(name)).toBe(false);
      expect(await reserveHttpToolCall(db, child, ctx, name, { id: 'before' })).toBe(true);
    }
    for (let i = 0; i < agent.maxToolCallsPerTurn; i++) {
      expect(await reserveHttpToolCall(db, child, ctx, 'recall', { topic: `topic-${i}` })).toBe(
        true,
      );
      expect(await reserveHttpToolCall(db, child, ctx, 'recall', { topic: `topic-${i}` })).toBe(
        true,
      );
    }
    for (const name of BUDGETED_TOOLS)
      expect(await reserveHttpToolCall(db, child, ctx, name, { id: 'new' })).toBe(false);
    for (const name of free)
      expect(await reserveHttpToolCall(db, child, ctx, name, { id: 'after' })).toBe(true);
    expect(
      await reserveHttpToolCall(db, child, { ...ctx, operationId: 'turn-2' }, 'record_mood', {
        weather: 'sunny',
      }),
    ).toBe(true);
  });
});
