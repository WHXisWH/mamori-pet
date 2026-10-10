import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChatSafetyRes } from '@ijime/api-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChildApiError, childRequest, saveCrisis } from '@/lib/api';
import type * as ApiModule from '@/lib/api';
import type { ChatClient, ChatEventHandlers } from '@/lib/chat-client';
import { useChildStore } from '@/lib/store';
import { ChatPanel } from './ChatPanel';

const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  childRequest: vi.fn(),
  saveCrisis: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const scrollToDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T03:00:00Z'));
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  useChildStore.setState({
    gradeBand: 'high',
    characterId: 'moko',
    readAloud: false,
    dataSources: { ...useChildStore.getState().dataSources, voice: false },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useChildStore.getState().reset();
  if (scrollToDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollToDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  if (scrollIntoViewDescriptor)
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

function input() {
  return screen.getByTestId('chat-input') as HTMLTextAreaElement;
}

function sendText(text: string) {
  vi.setSystemTime(Date.now() + 1_000);
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.click(screen.getByTestId('chat-send'));
}

async function setup(initialSafety: ChatSafetyRes = { status: 'clear' }) {
  const transition = deferred<unknown>();
  const safety = vi
    .fn<(path: string, init?: RequestInit) => Promise<ChatSafetyRes>>()
    .mockResolvedValue(initialSafety);
  vi.mocked(childRequest).mockImplementation(async (path, init) => {
    if (path.endsWith('/safety')) return safety(path, init);
    if (path === '/v1/child/chat/sessions') {
      return {
        items: ['current', 'history', 'new'].map((sessionId) => ({
          sessionId,
          startedAt: '2026-10-06T03:00:00Z',
        })),
      };
    }
    return transition.promise;
  });
  const requests: {
    sessionId: string;
    handlers: ChatEventHandlers;
    signal: AbortSignal | undefined;
    result: ReturnType<typeof deferred<void>>;
  }[] = [];
  const retries: ((typeof requests)[number] & { messageId: string })[] = [];
  const client: ChatClient = {
    startSession: vi
      .fn()
      .mockResolvedValueOnce({ sessionId: 'current', openingMessage: 'Initial opening' })
      .mockResolvedValue({ sessionId: 'new', openingMessage: 'New opening' }),
    send: vi.fn((sessionId, _req, handlers, signal) => {
      const result = deferred<void>();
      requests.push({ sessionId, handlers, signal, result });
      return result.promise;
    }),
    retry: vi.fn((sessionId, messageId, handlers, signal) => {
      const result = deferred<void>();
      retries.push({ sessionId, messageId, handlers, signal, result });
      return result.promise;
    }),
  };
  const view = render(<ChatPanel client={client} />);
  await screen.findByTestId('open-session-history');
  fireEvent.click(screen.getByTestId('session-manager'));
  await waitFor(() => expect(input().disabled).toBe(initialSafety.status !== 'clear'));
  return { client, requests, transition, safety, retries, view };
}

describe('ChatPanel request ownership', () => {
  it('shows the knowledge-base opening separately from the model reply beside its help entry', async () => {
    const { requests } = await setup();
    sendText('先生にどう話せばいい？');
    const current = requests[0]!;
    const openingLine = '「ねえ、ちょっと話したいことがあるんだ。」';
    await act(async () => {
      current.handlers.onMeta('help', false);
      current.handlers.onAction({
        type: 'offer_tell_adult',
        consultationId: 'help-1',
        openingLine,
      });
      current.handlers.onDelta('いっしょに準備しよう。');
      current.handlers.onDone('help');
      current.result.resolve();
    });
    expect(screen.getByTestId('help-opening-line').textContent).toBe(openingLine);
    expect(screen.getByText('ことばの れい')).toBeTruthy();
    expect(screen.getByTestId('offer-tell-adult').closest('a')?.getAttribute('href')).toBe(
      '/tell?consultationId=help-1',
    );
    expect(screen.getAllByTestId('msg-pet').at(-1)?.textContent).toBe('いっしょに準備しよう。');
  });

  it.each([
    ['sending', 'open'],
    ['streaming', 'open'],
    ['sending', 'delete'],
    ['streaming', 'delete'],
  ] as const)(
    'recovers from %s after %s and ignores callbacks from the aborted request',
    async (phase, action) => {
      const { client, requests, transition } = await setup();
      sendText('First question');
      const old = requests[0]!;
      if (phase === 'streaming') {
        act(() => {
          old.handlers.onMeta('first', false);
          old.handlers.onDelta('Old partial response');
        });
      }
      act(() => {
        old.handlers.onAction({ type: 'quick_replies', options: ['Old quick reply'] });
        old.handlers.onAction({ type: 'offer_tell_adult', consultationId: 'old-offer' });
      });
      expect(screen.getByTestId('chat-panel').getAttribute('data-status')).toBe(phase);
      fireEvent.click(
        screen.getByTestId(action === 'open' ? 'open-session-history' : 'delete-session-current'),
      );
      expect(input().disabled).toBe(true);

      await act(async () => {
        transition.resolve(
          action === 'open'
            ? { items: [{ messageId: 'history-message', role: 'pet', text: 'History response' }] }
            : undefined,
        );
      });
      const currentText = action === 'open' ? 'History response' : 'New opening';
      await screen.findByText(currentText);
      expect(old.signal?.aborted).toBe(true);
      expect(screen.getByTestId('chat-panel').getAttribute('data-status')).toBe('idle');
      expect(input().disabled).toBe(false);
      expect(screen.queryByTestId('quick-replies')).toBeNull();
      expect(screen.queryByTestId('offer-tell-adult')).toBeNull();

      sendText('Next question');
      expect(client.send).toHaveBeenCalledTimes(2);
      const current = requests[1]!;
      expect(current.sessionId).toBe(action === 'open' ? 'history' : 'new');
      act(() => {
        current.handlers.onMeta('current', false);
        current.handlers.onDelta('Current response');
      });
      await act(async () => {
        old.handlers.onMeta('late', false);
        old.handlers.onDelta('Late old response');
        old.handlers.onAction({ type: 'quick_replies', options: ['Late quick reply'] });
        old.handlers.onAction({ type: 'offer_tell_adult', consultationId: 'late-offer' });
        old.handlers.onReview?.(pending);
        old.handlers.onDone('late');
        old.handlers.onError(new Error('Late stream error'));
        old.result.reject(new Error('Aborted request settled late'));
      });
      expect(screen.getByTestId('chat-panel').getAttribute('data-status')).toBe('streaming');
      expect(input().disabled).toBe(true);
      expect(screen.getAllByTestId('msg-pet').map((item) => item.textContent)).toEqual([
        currentText,
        'Current response',
      ]);
      expect(screen.queryByTestId('quick-replies')).toBeNull();
      expect(screen.queryByTestId('offer-tell-adult')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();

      await act(async () => {
        current.handlers.onDone('current');
        current.result.resolve();
      });
      await waitFor(() => expect(input().disabled).toBe(false));
      expect(saveCrisis).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
    },
  );

  it.each(['done', 'error'] as const)(
    'releases ownership on %s so late callbacks cannot change the next send',
    async (terminal) => {
      const { requests } = await setup();
      sendText('First question');
      const old = requests[0]!;
      await act(async () => {
        old.handlers.onMeta('first', false);
        old.handlers.onDelta('First response');
        if (terminal === 'done') old.handlers.onDone('first');
        else old.handlers.onError(new Error('Request failed'));
      });
      expect(input().disabled).toBe(false);
      sendText('Next question');
      const current = requests[1]!;
      act(() => {
        current.handlers.onMeta('current', false);
        current.handlers.onDelta('Current response');
      });
      await act(async () => {
        old.handlers.onMeta('late', false);
        old.handlers.onDelta('Late old response');
        old.handlers.onAction({ type: 'quick_replies', options: ['Late quick reply'] });
        old.handlers.onDone('late');
        old.handlers.onError(new Error('Late error'));
        old.result.reject(new Error('Late rejection'));
      });
      expect(old.signal?.aborted).toBe(false);
      expect(screen.getByTestId('chat-panel').getAttribute('data-status')).toBe('streaming');
      expect(input().disabled).toBe(true);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByTestId('quick-replies')).toBeNull();
      expect(screen.queryByText(/Late old response/)).toBeNull();
      await act(async () => {
        current.handlers.onDone('current');
        current.result.resolve();
      });
      expect(input().disabled).toBe(false);
    },
  );

  it('unlocks the existing session when opening a different session fails', async () => {
    const { requests, transition } = await setup();
    sendText('First question');
    const old = requests[0]!;
    act(() => {
      old.handlers.onMeta('first', false);
      old.handlers.onDelta('Partial response');
    });
    fireEvent.click(screen.getByTestId('open-session-history'));
    await act(async () => transition.reject(new Error('History unavailable')));
    expect(old.signal?.aborted).toBe(true);
    expect(input().disabled).toBe(false);
    expect(screen.getByRole('alert')).toBeTruthy();
    sendText('Continue current session');
    expect(requests[1]?.sessionId).toBe('current');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the active request when deleting the current session fails', async () => {
    const { requests, transition } = await setup();
    sendText('First question');
    const current = requests[0]!;
    fireEvent.click(screen.getByTestId('delete-session-current'));
    await act(async () => transition.reject(new Error('Delete unavailable')));
    expect(current.signal?.aborted).toBe(false);
    expect(input().disabled).toBe(true);
    await act(async () => {
      current.handlers.onMeta('current', false);
      current.handlers.onDelta('Current response');
      current.handlers.onDone('current');
      current.result.resolve();
    });
    expect(input().disabled).toBe(false);
    expect(screen.getByText('Current response')).toBeTruthy();
  });

  it('still handles crisis events globally after a session change', async () => {
    const { requests, transition } = await setup();
    sendText('First question');
    const old = requests[0]!;
    fireEvent.click(screen.getByTestId('open-session-history'));
    await act(async () => transition.resolve({ items: [] }));
    sendText('Next question');
    const crisis = { crisisId: 'cr-test', message: 'Safety message', resources: [] };
    act(() => old.handlers.onCrisis(crisis));
    expect(saveCrisis).toHaveBeenCalledWith(crisis);
    expect(router.replace).toHaveBeenCalledWith('/safe');
    expect(requests[1]?.signal?.aborted).toBe(true);
  });
});

const pending: Extract<ChatSafetyRes, { status: 'pending_review' }> = {
  status: 'pending_review',
  messageId: 'saved-message',
  message: 'いまは おはなしを かくにんしているよ。こまっていたら たすけを もとめてね。',
  resources: [
    {
      id: 'emergency',
      name: 'いそいで たすけてほしいとき',
      audience: 'すぐに助けが必要な人',
      phone: '110 / 119',
    },
    {
      id: 'family',
      name: 'おうちのことで こまったとき',
      audience: 'こども',
      phone: '189',
      hours: '24時間',
    },
  ],
};

describe('ChatPanel pending safety and stored-message retry', () => {
  it('keeps the new reply retry permission when an older safety GET returns clear late', async () => {
    const { requests, safety, transition, client, retries } = await setup();
    const stale = deferred<ChatSafetyRes>();
    safety.mockReturnValueOnce(stale.promise);
    fireEvent.click(screen.getByTestId('delete-session-history'));
    await act(async () => transition.resolve(undefined));
    expect(safety).toHaveBeenCalledTimes(2);
    const staleSignal = safety.mock.calls[1]![1]?.signal;
    expect(input().disabled).toBe(false);

    sendText('もとの おはなし');
    act(() => {
      requests[0]!.handlers.onMeta('current-message', false);
      requests[0]!.handlers.onDelta('あとで ためしてね。');
      requests[0]!.handlers.onDone('reply', true);
    });
    expect(screen.getByTestId('chat-retry')).toBeTruthy();
    await act(async () => stale.resolve({ status: 'clear' }));
    expect(screen.getByTestId('chat-retry')).toBeTruthy();
    expect(staleSignal?.aborted).toBe(true);
    fireEvent.click(screen.getByTestId('chat-retry'));
    expect(retries[0]?.messageId).toBe('current-message');
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it.each(['sending', 'streaming'] as const)(
    'does not start a queued safety check while the current turn is %s',
    async (phase) => {
      const { requests, safety, transition } = await setup();
      const queued = deferred<ChatSafetyRes>();
      safety.mockReturnValueOnce(queued.promise);
      sendText('もとの おはなし');
      if (phase === 'streaming') act(() => requests[0]!.handlers.onMeta('current-message', false));
      fireEvent.click(screen.getByTestId('delete-session-history'));
      await act(async () => transition.resolve(undefined));
      expect(safety).toHaveBeenCalledTimes(1);
      expect(input().disabled).toBe(true);
      act(() => {
        if (phase === 'sending') requests[0]!.handlers.onMeta('current-message', false);
        requests[0]!.handlers.onDone('reply', true);
      });
      await act(async () => queued.resolve({ status: 'clear' }));
      expect(screen.getByTestId('chat-retry')).toBeTruthy();
      expect(safety).toHaveBeenCalledTimes(1);
    },
  );

  it('checks safety on session opening and restores pending help before allowing input', async () => {
    const { client, safety } = await setup(pending);
    expect(safety.mock.calls[0]?.[0]).toBe('/v1/child/chat/sessions/current/safety');
    expect(screen.getByTestId('pending-review-message').textContent).toBe(pending.message);
    expect(input().disabled).toBe(true);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('shows immediate server help without declaring crisis and pauses every input mode', async () => {
    const { requests, safety } = await setup();
    act(() =>
      useChildStore.setState({
        dataSources: { ...useChildStore.getState().dataSources, voice: true },
      }),
    );
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    sendText('おうちが こわい');
    act(() => {
      requests[0]!.handlers.onMeta(pending.messageId, false);
      requests[0]!.handlers.onAction({ type: 'quick_replies', options: ['きいてほしい'] });
      requests[0]!.handlers.onReview?.(pending);
      requests[0]!.handlers.onDone('fallback_review', true);
    });
    expect(screen.getByTestId('pending-review-message').textContent).toBe(pending.message);
    expect(
      screen.getAllByTestId('pending-review-call').map((link) => link.getAttribute('href')),
    ).toEqual(['tel:110', 'tel:119', 'tel:189']);
    expect(input().disabled).toBe(true);
    expect((screen.getByTestId('voice-toggle') as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'きいてほしい' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByTestId('chat-retry')).toBeNull();
    expect(saveCrisis).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(safety).toHaveBeenCalledTimes(1);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
      block: 'start',
      behavior: 'smooth',
    });
    safety.mockResolvedValue({ ...pending });
    await act(async () => vi.advanceTimersByTimeAsync(2999));
    expect(safety).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('routes a delayed confirmed crisis through the existing global safety handler', async () => {
    const { requests, safety } = await setup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const crisis = {
      crisisId: 'reviewed-crisis',
      message: 'Confirmed help',
      resources: pending.resources,
    };
    safety.mockResolvedValue({ status: 'crisis', crisis });
    sendText('たすけて');
    act(() => requests[0]!.handlers.onReview?.(pending));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(saveCrisis).toHaveBeenCalledExactlyOnceWith(crisis);
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/safe');
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(safety).toHaveBeenCalledTimes(2);
  });

  it('continues the stored message after clear without asking for new text or auto retrying', async () => {
    const { client, requests, safety, retries } = await setup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    safety.mockResolvedValue({ status: 'clear', resumeMessageId: pending.messageId });
    sendText('もとの おはなし');
    act(() => {
      requests[0]!.handlers.onMeta(pending.messageId, false);
      requests[0]!.handlers.onReview?.(pending);
    });
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.queryByTestId('pending-review-help')).toBeNull();
    expect(client.retry).not.toHaveBeenCalled();
    expect(input().disabled).toBe(false);
    fireEvent.click(screen.getByTestId('chat-continue'));
    expect(retries[0]?.messageId).toBe(pending.messageId);
    expect(retries[0]?.sessionId).toBe('current');
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('msg-child')).toHaveLength(1);
    await act(async () => {
      retries[0]!.handlers.onMeta(pending.messageId, false);
      retries[0]!.handlers.onDelta('きかせてくれて ありがとう。');
      retries[0]!.handlers.onDone('reply', false);
      retries[0]!.result.resolve();
      await vi.advanceTimersByTimeAsync(9000);
    });
    expect(safety).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('chat-continue')).toBeNull();
    expect(screen.queryByTestId('chat-retry')).toBeNull();
    expect(screen.getByText('きかせてくれて ありがとう。')).toBeTruthy();
  });

  it('keeps immediate help and input paused across polling errors, then polls again', async () => {
    const { requests, safety } = await setup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    safety.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(pending);
    sendText('こまっている');
    act(() => requests[0]!.handlers.onReview?.(pending));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.getByTestId('pending-review-help')).toBeTruthy();
    expect(screen.getByTestId('safety-retry')).toBeTruthy();
    expect(input().disabled).toBe(true);
    expect(screen.queryByTestId('chat-continue')).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(safety).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId('safety-retry')).toBeNull();
    expect(input().disabled).toBe(true);
  });

  it.each(['switch', 'unmount'] as const)(
    'cancels pending polling on %s and ignores the stale response',
    async (action) => {
      const { requests, safety, transition, view } = await setup();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const late = deferred<ChatSafetyRes>();
      safety.mockReturnValueOnce(late.promise).mockResolvedValue({ status: 'clear' });
      sendText('こまっている');
      act(() => requests[0]!.handlers.onReview?.(pending));
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      const signal = safety.mock.calls[1]![1]?.signal;
      if (action === 'unmount') view.unmount();
      else {
        fireEvent.click(screen.getByTestId('open-session-history'));
        await act(async () => transition.resolve({ items: [] }));
      }
      expect(signal?.aborted).toBe(true);
      await act(async () => {
        late.resolve({
          status: 'crisis',
          crisis: { crisisId: 'old', message: 'old', resources: [] },
        });
        await vi.advanceTimersByTimeAsync(12000);
      });
      expect(saveCrisis).not.toHaveBeenCalled();
      expect(router.replace).not.toHaveBeenCalled();
      expect(safety).toHaveBeenCalledTimes(action === 'switch' ? 3 : 2);
      if (action === 'switch') {
        expect(screen.queryByTestId('pending-review-help')).toBeNull();
        expect(input().disabled).toBe(false);
      }
    },
  );

  it('recovers a pending session after remount without starting a new conversation', async () => {
    useChildStore.setState({ childId: 'paired-child' });
    const { client, requests, safety, view } = await setup();
    sendText('もとの おはなし');
    act(() => requests[0]!.handlers.onReview?.(pending));
    const pointer = sessionStorage.getItem('mamori-chat-session:paired-child')!;
    expect(JSON.parse(pointer)).toEqual({ sessionId: 'current' });
    expect(pointer).not.toContain('もとの おはなし');
    view.unmount();
    safety.mockResolvedValue(pending);
    vi.mocked(childRequest).mockImplementation(async (path, init) => {
      if (path.endsWith('/safety')) return safety(path, init);
      if (path.endsWith('/messages'))
        return {
          items: [{ messageId: pending.messageId, role: 'child', text: 'もとの おはなし' }],
        };
      return { items: [] };
    });
    render(<ChatPanel client={client} />);
    await screen.findByTestId('pending-review-help');
    expect(client.startSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('msg-child').textContent).toBe('もとの おはなし');
    expect(input().disabled).toBe(true);
    expect(client.retry).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'uses the server resume eligibility (%s) after reopening an already clear session',
    async (eligible) => {
      useChildStore.setState({ childId: 'paired-child' });
      const { client, requests, view, retries } = await setup();
      sendText('もとの おはなし');
      act(() => requests[0]!.handlers.onReview?.(pending));
      view.unmount();
      vi.mocked(childRequest).mockImplementation(async (path) => {
        if (path.endsWith('/safety'))
          return { status: 'clear', ...(eligible ? { resumeMessageId: 'server-resume-id' } : {}) };
        if (path.endsWith('/messages'))
          return {
            items: [{ messageId: pending.messageId, role: 'child', text: 'もとの おはなし' }],
          };
        return { items: [] };
      });
      render(<ChatPanel client={client} />);
      await waitFor(() => expect(input().disabled).toBe(false));
      expect(client.startSession).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('pending-review-help')).toBeNull();
      expect(client.retry).not.toHaveBeenCalled();
      if (eligible) {
        fireEvent.click(screen.getByTestId('chat-retry'));
        expect(retries[0]?.messageId).toBe('server-resume-id');
        expect(client.send).toHaveBeenCalledTimes(1);
      } else expect(screen.queryByTestId('chat-retry')).toBeNull();
    },
  );

  it('clears a pending continuation when the server returns clear without a resume ID', async () => {
    const { requests, client } = await setup();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    sendText('おはなし');
    act(() => requests[0]!.handlers.onReview?.(pending));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(screen.queryByTestId('chat-continue')).toBeNull();
    expect(screen.queryByTestId('chat-retry')).toBeNull();
    expect(input().disabled).toBe(false);
    expect(client.retry).not.toHaveBeenCalled();
  });

  it('does not show successful continuation on a rejected retry and refreshes server safety', async () => {
    const { requests, retries, safety, client } = await setup();
    sendText('おはなし');
    act(() => {
      requests[0]!.handlers.onMeta('stored', false);
      requests[0]!.handlers.onDelta('あとで ためしてね。');
      requests[0]!.handlers.onDone('reply', true);
    });
    safety.mockResolvedValue(pending);
    fireEvent.click(screen.getByTestId('chat-retry'));
    await act(async () => retries[0]!.handlers.onError(new ChildApiError('PENDING_REVIEW', 409)));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('pending-review-help')).toBeTruthy();
    expect(screen.queryByTestId('chat-retry')).toBeNull();
    expect(screen.queryByTestId('chat-continue')).toBeNull();
    expect(input().disabled).toBe(true);
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(screen.getByText('あとで ためしてね。')).toBeTruthy();
  });

  it('recovers the original server ID after losing meta and removes the new-message resend button', async () => {
    const { requests, retries, safety, client } = await setup();
    safety.mockResolvedValue({ status: 'clear', resumeMessageId: 'stored-before-disconnect' });
    sendText('もとの おはなし');
    await act(async () => requests[0]!.handlers.onError(new Error('Disconnected before meta')));
    expect(screen.queryByRole('button', { name: 'もういちど' })).toBeNull();
    fireEvent.click(screen.getByTestId('chat-retry'));
    expect(retries[0]?.messageId).toBe('stored-before-disconnect');
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId('msg-child')).toHaveLength(1);
  });

  it.each(['callback', 'rejection'] as const)(
    'never resends an ambiguous pre-meta transport %s as a new message',
    async (failure) => {
      const { requests, safety, client } = await setup();
      sendText('もとの おはなし');
      await act(async () => {
        const error = new Error('Connection lost after the server may have saved the message');
        if (failure === 'callback') requests[0]!.handlers.onError(error);
        else requests[0]!.result.reject(error);
      });
      expect(safety).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId('msg-child').textContent).toBe('もとの おはなし');
      expect(screen.getByRole('alert')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'もういちど' })).toBeNull();
      expect(screen.queryByTestId('chat-retry')).toBeNull();
      expect(screen.queryByTestId('chat-continue')).toBeNull();
      expect(input().disabled).toBe(false);
      expect(client.send).toHaveBeenCalledTimes(1);
      expect(client.retry).not.toHaveBeenCalled();
    },
  );

  it('does not reuse retry permission after a failed retry while the server has no resume ID', async () => {
    const { requests, retries, safety, client } = await setup();
    sendText('もとの おはなし');
    act(() => {
      requests[0]!.handlers.onMeta('stored', false);
      requests[0]!.handlers.onDelta('あとで ためしてね。');
      requests[0]!.handlers.onDone('reply', true);
    });
    const checking = deferred<ChatSafetyRes>();
    safety.mockReturnValueOnce(checking.promise);
    fireEvent.click(screen.getByTestId('chat-retry'));
    await act(async () => retries[0]!.result.reject(new Error('Reply may still be generating')));
    expect(input().disabled).toBe(true);
    expect(screen.queryByTestId('chat-retry')).toBeNull();
    await act(async () => checking.resolve({ status: 'clear' }));
    expect(input().disabled).toBe(false);
    expect(screen.queryByTestId('chat-retry')).toBeNull();
    expect(screen.queryByTestId('chat-continue')).toBeNull();
    expect(screen.queryByRole('button', { name: 'もういちど' })).toBeNull();
    expect(screen.getByTestId('msg-child').textContent).toBe('もとの おはなし');
    expect(screen.getByText('あとで ためしてね。')).toBeTruthy();
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(client.retry).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, false])(
    'does not infer retry permission from a fallback ID when retryable is %s',
    async (retryable) => {
      const { requests, client } = await setup();
      sendText('おはなし');
      act(() => {
        requests[0]!.handlers.onMeta('stored', false);
        requests[0]!.handlers.onDelta('いまは へんじが むずかしいよ。');
        requests[0]!.handlers.onAction({ type: 'offer_tell_adult', consultationId: 'existing' });
        requests[0]!.handlers.onDone('fallback_anything', retryable);
      });
      expect(screen.queryByTestId('chat-retry')).toBeNull();
      expect(screen.getByText('いまは へんじが むずかしいよ。')).toBeTruthy();
      expect(screen.getAllByTestId('offer-tell-adult')).toHaveLength(1);
      expect(client.retry).not.toHaveBeenCalled();
    },
  );

  it('retries only an explicitly permitted stored message and preserves its existing reply', async () => {
    const { requests, client, retries } = await setup();
    sendText('もとの おはなし');
    act(() => {
      requests[0]!.handlers.onMeta('stable-original-id', false);
      requests[0]!.handlers.onDelta('あとで もういちど ためしてね。');
      requests[0]!.handlers.onDone('any-reply-id', true);
    });
    fireEvent.click(screen.getByTestId('chat-retry'));
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(retries[0]?.messageId).toBe('stable-original-id');
    expect(screen.getAllByTestId('msg-child')).toHaveLength(1);
    expect(screen.getByText('あとで もういちど ためしてね。')).toBeTruthy();
    act(() => {
      retries[0]!.handlers.onMeta('stable-original-id', false);
      retries[0]!.handlers.onDelta('いっしょに かんがえよう。');
      retries[0]!.handlers.onAction({ type: 'offer_tell_adult', consultationId: 'new-offer' });
      retries[0]!.handlers.onDone('fallback_with_action', false);
    });
    expect(screen.getAllByTestId('offer-tell-adult')).toHaveLength(1);
    expect(screen.getByText('いっしょに かんがえよう。')).toBeTruthy();
    expect(screen.queryByTestId('chat-retry')).toBeNull();
  });
});
