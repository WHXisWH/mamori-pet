import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory, PET_APP_NAME } from '@ijime/agent-core';
import { agent, island } from '@ijime/config';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createRuntime, type PetRuntime } from './runtime.js';

let db: Firestore;
let rt: PetRuntime;
beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-game-budget-${process.pid}` });
  rt = await createRuntime({
    db,
    directory: new DevChildDirectory(db),
    kb: await Kb.load(
      new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
    ),
  });
});
afterAll(() => db.terminate());

async function setup(childId: string) {
  const session = await rt.sessions.createSession({ appName: PET_APP_NAME, userId: childId });
  return async (
    operationId: string,
    name = 'suggest_game',
    args: Record<string, unknown> = { type: 'drawing' },
  ) => {
    const res = await createApp(async () => rt).request(`/internal/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId, sessionId: session.id, operationId, args }),
    });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ result: Record<string, unknown>; actions: unknown[] }>;
  };
}

describe('child-scoped weekly game budget', () => {
  it('is idempotent per operation and shared across sessions and game types', async () => {
    const suggest = await setup('c_game_week');
    const secondSession = await setup('c_game_week');
    const first = await suggest('turn_1');
    expect(first.result).toEqual({ ok: true, requestId: expect.stringMatching(/^req_/) });
    expect(first.actions).toEqual([
      { type: 'suggest_game', game: 'drawing', requestId: first.result['requestId'] },
    ]);
    expect(await suggest('turn_1')).toEqual(first);
    const child = (await rt.directory.lookup('c_game_week'))!;
    const request = await db
      .doc(
        `families/${child.familyId}/children/c_game_week/petRequests/${first.result['requestId']}`,
      )
      .get();
    expect(request.data()).toMatchObject({
      type: 'drawing',
      status: 'offered',
      rewardItemId: expect.any(String),
      promptId: expect.stringMatching(/^dr_/),
    });
    expect(
      request.get('expiresAt').toDate().getTime() - request.get('offeredAt').toDate().getTime(),
    ).toBe(island.petRequestExpiresDays * 86_400_000);
    for (let i = 1; i < agent.suggestGameWeeklyLimit; i++) {
      const next = (await secondSession(`turn_${i + 1}`, 'suggest_game', { type: 'pet_worry' }))
        .result;
      expect(next).toMatchObject({ ok: true });
      expect(next['requestId']).not.toBe(first.result['requestId']);
    }
    const legacy = await createApp(async () => rt).request('/internal/tools/suggest_game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ childId: 'c_game_week', sessionId: 'x', args: { type: 'island' } }),
    });
    expect(legacy.status).toBe(400);
    expect(await suggest('turn_over')).toEqual({
      result: { error: 'game_suggestion_limit' },
      actions: [],
    });
    expect((await suggest('help', 'show_help_resources', {})).result).toEqual({ ok: true });
    expect((await suggest('help', 'start_tell_adult', {})).result).toHaveProperty('consultationId');
  });

  it('does not oversubscribe concurrent requests from separate sessions', async () => {
    const calls = [];
    for (let i = 0; i < agent.suggestGameWeeklyLimit + 2; i++)
      calls.push(await setup('c_game_race'));
    const results = await Promise.all(calls.map((call, i) => call(`turn_${i}`)));
    expect(results.filter((r) => r.result['ok'] === true)).toHaveLength(
      agent.suggestGameWeeklyLimit,
    );
    const child = (await rt.directory.lookup('c_game_race'))!;
    const requests = await db
      .collection(`families/${child.familyId}/children/c_game_race/petRequests`)
      .get();
    expect(requests.size).toBe(agent.suggestGameWeeklyLimit);
    for (const denied of results.filter((r) => r.result['error']))
      expect(denied.actions).toEqual([]);
  });

  it('releases only expired reservations and does not share a budget with other children', async () => {
    const childId = 'c_game_expiry';
    const suggest = await setup(childId);
    const child = (await rt.directory.lookup(childId))!;
    const usage = db.doc(`families/${child.familyId}/children/${childId}/toolUsage/suggest_game`);
    const now = Date.now();
    await usage.set({
      timestamps: [new Date(now - 8 * 86_400_000), new Date(now - 6 * 86_400_000)],
    });
    expect((await suggest('new_turn')).result).toMatchObject({ ok: true });
    expect((await usage.get()).get('timestamps')).toHaveLength(2);
    expect((await suggest('over_turn')).result).toEqual({ error: 'game_suggestion_limit' });
    expect((await (await setup('c_game_other_child'))('first_turn')).result).toMatchObject({
      ok: true,
    });
  });

  it('allows crisis escalation after the game budget is exhausted', async () => {
    const suggest = await setup('c_game_crisis');
    for (let i = 0; i < agent.suggestGameWeeklyLimit; i++) await suggest(`turn_${i}`);
    expect((await suggest('over')).result).toEqual({ error: 'game_suggestion_limit' });
    expect(
      (await suggest('urgent', 'escalate_crisis', { reason: 'violence' })).result,
    ).toHaveProperty('crisisId');
  });
});
