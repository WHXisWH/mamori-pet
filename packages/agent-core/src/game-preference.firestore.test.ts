import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import type { PetAction } from '@ijime/api-types';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createPetAgent } from './agent.js';
import { createPetCallbacks } from './callbacks.js';
import { DevChildDirectory } from './child-directory.js';
import { FirestoreSessionService, PET_APP_NAME } from './firestore-session.js';
import { gamePreferenceChange, loadGamePreferenceRules } from './game-preference.js';
import { OutputFilter } from './output-filter.js';
import { ScriptedLlm } from './scripted-llm.js';
import { createPetTools, type PetToolExecutor } from './tools.js';
import { runPetTurn } from './turn.js';

let db: Firestore;
let kb: Kb;
beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-ijime-game-preference-${process.pid}` });
  kb = await Kb.load(new FsKbSource(new URL('../../../kb/v0.1.0', import.meta.url).pathname));
});
afterAll(() => db.terminate());

it('persists only a boolean across rebuilt agents and session services; new sessions start fresh', async () => {
  const childId = `c_game_${randomUUID()}`;
  const newService = () =>
    new FirestoreSessionService(db, new DevChildDirectory(db), { writeUserEvents: false });
  const initial = newService();
  const session = await initial.createSession({ appName: PET_APP_NAME, userId: childId });
  const filter = new OutputFilter({ rules: [] });
  const run = async (sessionId: string, text: string, tryGame = true) => {
    const sessions = newService();
    const { messageId } = await sessions.writeChildMessage(childId, sessionId, {
      text,
      inputMode: 'typed',
      crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
    });
    const actions: PetAction[] = [];
    const rules = await loadGamePreferenceRules(kb);
    const change = gamePreferenceChange(text, rules);
    if (change !== undefined) await sessions.setGameSuggestionsDeclined(childId, sessionId, change);
    const suggestGame = vi.fn(async () => true);
    let calls = 0;
    const model = new ScriptedLlm(() =>
      tryGame && calls++ === 0
        ? { calls: [{ name: 'suggest_game', args: { type: 'drawing' } }] }
        : { text: 'きょうの しまは、はれだよ。' },
    );
    const agent = createPetAgent({
      model,
      instruction: 'test',
      tools: createPetTools(
        { suggestGame } as unknown as PetToolExecutor,
        { childId, sessionId, gradeBand: 'low', characterId: 'moko' },
        (action) => actions.push(action),
      ),
      ...createPetCallbacks({
        filter,
        safeReply: 'SAFE',
        gamePreferenceRules: rules,
      }),
    });
    const gen = runPetTurn({
      agent,
      sessionService: sessions,
      childId,
      sessionId,
      messageId,
      text,
      gradeBand: 'low',
      filter,
      safeReply: 'SAFE',
      actions,
    });
    let result = await gen.next();
    while (!result.done) result = await gen.next();
    expect(result.value.fallback).toBeNull();
    return suggestGame;
  };
  await run(session.id, 'ゲームはしたくない。', false);
  const ref = db.doc(`families/f_dev_${childId}/children/${childId}/sessions/${session.id}`);
  expect((await ref.get()).get('adkState')).toEqual({ gameSuggestionsDeclined: true });
  for (const text of [
    'べつの はなしをしたい',
    'そらは どんないろ？',
    '「あそびたい」とともだちが言った。',
  ])
    expect(await run(session.id, text)).not.toHaveBeenCalled();
  expect(await run(session.id, 'いまは ゲームで あそびたい。')).toHaveBeenCalledTimes(1);
  expect((await ref.get()).get('adkState')).toEqual({ gameSuggestionsDeclined: false });
  await run(session.id, '今は遊ばない。', false);
  const other = await newService().createSession({ appName: PET_APP_NAME, userId: childId });
  expect(await run(other.id, 'ゲームで遊ぼう。')).toHaveBeenCalledTimes(1);
  expect((await ref.get()).get('adkState')).toEqual({ gameSuggestionsDeclined: true });
});
