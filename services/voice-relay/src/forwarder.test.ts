import type { TurnContext } from '@ijime/agent-core';
import { describe, expect, it, vi } from 'vitest';

import { forwardingExecutor } from './forwarder.js';

const ctx: TurnContext = { childId: 'c1', sessionId: 's1', gradeBand: 'high', characterId: 'moko' };

describe('voice tool safety gate', () => {
  it('blocks every write before checking, permits it after checking, and revokes on new speech', async () => {
    let allowed = false;
    const call = vi.fn(async () => ({ proposalId: 'p1', status: 'pending' }));
    const escalate = vi.fn(async () => ({ crisisId: 'k1' }));
    const executor = forwardingExecutor(call, escalate, () => allowed);
    const writes = [
      () => executor.recordMood(ctx, 'rainy'),
      () => executor.remember(ctx, 'test', 'like'),
      () => executor.startTellAdult(ctx),
      () => executor.suggestGame(ctx, 'island'),
    ];
    for (const write of writes) await expect(write()).rejects.toThrow('voice_safety_check_pending');
    expect(call).not.toHaveBeenCalled();
    expect(await executor.escalateCrisis(ctx, 'violence')).toEqual({ crisisId: 'k1' });
    allowed = true;
    expect(await executor.remember(ctx, 'test', 'like')).toEqual({
      proposalId: 'p1',
      status: 'pending',
    });
    expect(call).toHaveBeenCalledTimes(1);
    allowed = false;
    await expect(executor.recordMood(ctx, 'rainy')).rejects.toThrow('voice_safety_check_pending');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('forwards the same game budget reservation and its operation ID, denying invalid replies', async () => {
    const call = vi.fn(async () => ({ ok: true }) as unknown);
    const executor = forwardingExecutor(
      call,
      async () => ({ crisisId: 'k1' }),
      () => true,
    );
    const turn = { ...ctx, operationId: 'voice_turn_1' };
    expect(await executor.suggestGame(turn, 'island')).toBe(true);
    expect(call).toHaveBeenCalledWith('suggest_game', {
      childId: 'c1',
      sessionId: 's1',
      operationId: 'voice_turn_1',
      args: { type: 'island' },
    });
    for (const result of [{ error: 'game_suggestion_limit' }, undefined, null, {}]) {
      call.mockResolvedValueOnce(result);
      expect(await executor.suggestGame(turn, 'island')).toBe(false);
    }
  });
});
