import type { PetAction } from '@ijime/api-types';
import { describe, expect, it, vi } from 'vitest';

import { dispatch, MockChatClient, parseSse, type ChatEventHandlers } from './chat-client';

function handlers(): ChatEventHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onMeta: vi.fn((id, safe) => calls.push(`meta:${id}:${safe}`)),
    onDelta: vi.fn((t) => calls.push(`delta:${t}`)),
    onAction: vi.fn((a: PetAction) => calls.push(`action:${a.type}`)),
    onCrisis: vi.fn((c) => calls.push(`crisis:${c.crisisId}`)),
    onDone: vi.fn((id) => calls.push(`done:${id}`)),
    onError: vi.fn((e) => calls.push(`error:${e.message}`)),
  };
}

describe('parseSse', () => {
  it('parses complete event blocks and keeps the partial tail', () => {
    const chunk =
      'event: meta\ndata: {"messageId":"m_1","safeMode":false}\n\nevent: delta\ndata: {"text":"そっか"}\n\nevent: del';
    const { events, rest } = parseSse(chunk);
    expect(events).toEqual([
      { event: 'meta', data: { messageId: 'm_1', safeMode: false } },
      { event: 'delta', data: { text: 'そっか' } },
    ]);
    expect(rest).toBe('event: del');
  });

  it('dispatches each event type', () => {
    const h = handlers();
    dispatch({ event: 'meta', data: { messageId: 'm', safeMode: false } }, h);
    dispatch({ event: 'delta', data: { text: 'a' } }, h);
    dispatch({ event: 'action', data: { type: 'show_help_resources' } }, h);
    dispatch({ event: 'crisis', data: { crisisId: 'c', message: 'x', resources: [] } }, h);
    dispatch({ event: 'done', data: { replyMessageId: 'r' } }, h);
    expect(h.calls).toEqual([
      'meta:m:false',
      'delta:a',
      'action:show_help_resources',
      'crisis:c',
      'done:r',
    ]);
  });
});

describe('MockChatClient', () => {
  it('streams a reply and ends with done', async () => {
    const c = new MockChatClient();
    const s = await c.startSession();
    expect(s.sessionId).toMatch(/^mock_/);
    const h = handlers();
    await c.send(
      s.sessionId,
      { text: 'きょうは たのしかった', inputMode: 'typed', clientSentAt: 'x' },
      h,
    );
    expect(h.calls[0]).toMatch(/^meta:/);
    expect(h.calls.filter((x) => x.startsWith('delta:')).length).toBeGreaterThan(0);
    expect(h.calls.at(-1)).toMatch(/^done:/);
  });

  it('emits crisis for crisis keywords and nothing else', async () => {
    const c = new MockChatClient();
    const h = handlers();
    await c.send('s', { text: 'もう死にたい', inputMode: 'typed', clientSentAt: 'x' }, h);
    expect(h.calls).toEqual([expect.stringMatching(/^meta:.*:true$/), 'crisis:cr_mock']);
  });

  it('offers tell-adult when the child describes being ignored', async () => {
    const c = new MockChatClient();
    const h = handlers();
    await c.send('s', { text: 'みんなに無視された', inputMode: 'typed', clientSentAt: 'x' }, h);
    expect(h.calls).toContain('action:offer_tell_adult');
  });
});
