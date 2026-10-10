import type { PetAction, SseEvent } from '@ijime/api-types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ApiChatClient,
  dispatch,
  MockChatClient,
  parseSse,
  type ChatEventHandlers,
} from './chat-client';
import { childFetch, ChildApiError } from './api';
import type * as ApiModule from './api';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  childFetch: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

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

function eventResponse(events: SseEvent[]) {
  return new Response(
    events
      .map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
      .join(''),
    {
      headers: { 'Content-Type': 'text/event-stream' },
    },
  );
}

describe('ApiChatClient review and retry contract', () => {
  it('delivers a review-only terminal stream without reporting interruption', async () => {
    const pending = {
      status: 'pending_review' as const,
      messageId: 'stored',
      message: 'Help now',
      resources: [],
    };
    vi.mocked(childFetch).mockResolvedValue(
      eventResponse([
        { event: 'meta', data: { messageId: 'stored', safeMode: false } },
        { event: 'review', data: pending },
      ]),
    );
    const h = { ...handlers(), onReview: vi.fn() };
    await new ApiChatClient().send(
      'session',
      { text: 'text', inputMode: 'typed', clientSentAt: 'now' },
      h,
    );
    expect(h.onReview).toHaveBeenCalledExactlyOnceWith(pending);
    expect(h.onCrisis).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
    expect(() => dispatch({ event: 'review', data: pending }, handlers())).not.toThrow();
  });

  it.each([undefined, false, true])(
    'passes the explicit retryable=%s flag unchanged',
    async (retryable) => {
      const h = handlers();
      vi.mocked(childFetch).mockResolvedValue(
        eventResponse([
          {
            event: 'done',
            data: {
              replyMessageId: 'fallback_id',
              ...(retryable !== undefined ? { retryable } : {}),
            },
          },
        ]),
      );
      await new ApiChatClient().send(
        'session',
        { text: 'text', inputMode: 'typed', clientSentAt: 'now' },
        h,
      );
      expect(h.onDone).toHaveBeenCalledExactlyOnceWith('fallback_id', retryable);
    },
  );

  it('uses the authenticated reply endpoint with the original encoded IDs and no new text', async () => {
    const h = handlers();
    const controller = new AbortController();
    vi.mocked(childFetch).mockResolvedValue(
      eventResponse([
        { event: 'meta', data: { messageId: 'stored/id', safeMode: false } },
        { event: 'delta', data: { text: 'reply' } },
        { event: 'action', data: { type: 'offer_tell_adult', consultationId: 'help' } },
        { event: 'done', data: { replyMessageId: 'fallback_after_action', retryable: false } },
      ]),
    );
    await new ApiChatClient().retry('session/id', 'stored/id', h, controller.signal);
    expect(childFetch).toHaveBeenCalledExactlyOnceWith(
      '/v1/child/chat/sessions/session%2Fid/messages/stored%2Fid/reply',
      {
        method: 'POST',
        body: '{}',
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      },
    );
    expect(h.calls).toEqual([
      'meta:stored/id:false',
      'delta:reply',
      'action:offer_tell_adult',
      'done:fallback_after_action',
    ]);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('reports a pending-review 409 as an error, never a successful reply', async () => {
    vi.mocked(childFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'PENDING_REVIEW' } }), { status: 409 }),
    );
    const h = handlers();
    await new ApiChatClient().retry('session', 'stored', h);
    expect(h.onError).toHaveBeenCalledWith(new ChildApiError('PENDING_REVIEW', 409));
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.onDelta).not.toHaveBeenCalled();
    expect(childFetch).toHaveBeenCalledTimes(1);
  });
});
