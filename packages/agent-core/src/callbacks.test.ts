import { describe, expect, it, vi } from 'vitest';

import { createPetCallbacks } from './callbacks.js';
import { OutputFilter } from './output-filter.js';

const filter = new OutputFilter({
  rules: [{ id: 'secret', patterns: ['二人だけの秘密'] }],
} as never);
const single = <T>(callback: T | T[]) => (Array.isArray(callback) ? callback[0]! : callback);
const context = { invocationId: 'test-turn' } as never;

describe('pet ADK callbacks', () => {
  it('withholds partial output until remote inspection succeeds', async () => {
    const inspectOutput = vi.fn(async () => true);
    const callback = single(
      createPetCallbacks({ filter, safeReply: 'うん。', inspectOutput }).afterModelCallback,
    );
    const first = await callback({
      context,
      response: { partial: true, content: { role: 'model', parts: [{ text: 'こんにちは。' }] } },
    });
    expect(first?.content?.parts).toEqual([]);
    expect(inspectOutput).not.toHaveBeenCalled();
    const final = await callback({
      context,
      response: { partial: false, content: { role: 'model', parts: [] } },
    });
    expect(inspectOutput).toHaveBeenCalledWith('こんにちは。');
    expect(final?.content?.parts).toEqual([{ text: 'こんにちは。' }]);
  });

  it('blocks failed inspection but preserves crisis escalation', async () => {
    const inspectOutput = vi.fn(async () => {
      throw new Error('sensitive provider error');
    });
    const callback = single(
      createPetCallbacks({ filter, safeReply: 'うん。', inspectOutput }).afterModelCallback,
    );
    const blocked = await callback({
      context,
      response: { content: { role: 'model', parts: [{ text: 'こんにちは。' }] } },
    });
    expect(blocked?.errorCode).toBe('OUTPUT_BLOCKED');
    const safety = { functionCall: { name: 'escalate_crisis', args: { category: 'violence' } } };
    const rescued = await callback({
      context,
      response: { content: { role: 'model', parts: [{ text: 'こんにちは。' }, safety] } },
    });
    expect(rescued?.content?.parts).toEqual([safety, { text: 'うん。' }]);
  });

  it('leaves remember args for the tool, which pseudonymizes after the budget check', async () => {
    const callback = single(createPetCallbacks({ filter, safeReply: 'うん。' }).beforeToolCallback);
    const args = { content: '田中くんと遊ぶ', category: 'person' };
    expect(await callback({ tool: { name: 'remember' } as never, args, context })).toBeUndefined();
    expect(args.content).toBe('田中くんと遊ぶ');
  });

  it('does not execute malformed or blocked memory arguments', async () => {
    const callback = single(createPetCallbacks({ filter, safeReply: 'うん。' }).beforeToolCallback);
    const call = (args: Record<string, unknown>) =>
      callback({ tool: { name: 'remember' } as never, args, context });
    expect(await call({})).toEqual({ error: 'invalid_arguments' });
    expect(await call({ content: '二人だけの秘密', category: 'other' })).toEqual({
      error: 'output_blocked',
    });
  });

  it('blocks phrases split across streaming chunks without leaking them in errors', async () => {
    const callback = single(createPetCallbacks({ filter, safeReply: 'うん。' }).afterModelCallback);
    expect(
      await callback({
        context,
        response: { partial: true, content: { role: 'model', parts: [{ text: '二人だけの' }] } },
      }),
    ).toBeUndefined();
    const blocked = await callback({
      context,
      response: { partial: true, content: { role: 'model', parts: [{ text: '秘密だよ。' }] } },
    });
    expect(blocked).toEqual({
      errorCode: 'OUTPUT_BLOCKED',
      errorMessage: 'output_blocked',
      partial: false,
    });
    expect(JSON.stringify(blocked)).not.toContain('秘密');
    expect(
      await callback({
        context: { invocationId: 'next-turn' } as never,
        response: { content: { role: 'model', parts: [{ text: 'きょうは何をした？' }] } },
      }),
    ).toBeUndefined();
  });

  it('preserves a safety call while dropping blocked text and business tools', async () => {
    const callback = single(createPetCallbacks({ filter, safeReply: 'うん。' }).afterModelCallback);
    const response = await callback({
      context,
      response: {
        content: {
          role: 'model',
          parts: [
            { text: '二人だけの秘密。' },
            { functionCall: { name: 'escalate_crisis', args: { category: 'self_harm' } } },
            { functionCall: { name: 'remember', args: { content: '秘密', category: 'other' } } },
          ],
        },
      },
    });
    expect(response?.content?.parts).toEqual([
      { functionCall: { name: 'escalate_crisis', args: { category: 'self_harm' } } },
      { text: 'うん。' },
    ]);
  });
});
