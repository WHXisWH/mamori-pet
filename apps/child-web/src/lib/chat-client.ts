import type {
  ChatSafetyRes,
  CrisisPayload,
  PetAction,
  SendMessageReq,
  SseEvent,
  StartSessionRes,
} from '@ijime/api-types';

import { ChildApiError, childFetch } from './api';

export type ChatEventHandlers = {
  onMeta: (messageId: string, safeMode: boolean) => void;
  onDelta: (text: string) => void;
  onAction: (action: PetAction) => void;
  onCrisis: (payload: CrisisPayload) => void;
  onReview?: (pending: Extract<ChatSafetyRes, { status: 'pending_review' }>) => void;
  onDone: (replyMessageId: string, retryable?: boolean) => void;
  onError: (err: Error) => void;
};

export interface ChatClient {
  startSession(): Promise<StartSessionRes>;
  send(
    sessionId: string,
    req: SendMessageReq,
    h: ChatEventHandlers,
    signal?: AbortSignal,
  ): Promise<void>;
  retry?(
    sessionId: string,
    messageId: string,
    h: ChatEventHandlers,
    signal?: AbortSignal,
  ): Promise<void>;
}

export function parseSse(chunk: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const blocks = chunk.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = '';
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!event || !data) continue;
    events.push({ event, data: JSON.parse(data) } as SseEvent);
  }
  return { events, rest };
}

export function dispatch(ev: SseEvent, h: ChatEventHandlers): void {
  switch (ev.event) {
    case 'meta':
      h.onMeta(ev.data.messageId, ev.data.safeMode);
      break;
    case 'delta':
      h.onDelta(ev.data.text);
      break;
    case 'action':
      h.onAction(ev.data);
      break;
    case 'crisis':
      h.onCrisis(ev.data);
      break;
    case 'review':
      h.onReview?.(ev.data);
      break;
    case 'done':
      h.onDone(ev.data.replyMessageId, ev.data.retryable);
      break;
  }
}

export class ApiChatClient implements ChatClient {
  async startSession(): Promise<StartSessionRes> {
    const res = await childFetch('/v1/child/chat/sessions', {
      method: 'POST',
      body: '{}',
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      throw new ChildApiError(body?.error?.code ?? 'REQUEST_FAILED', res.status);
    }
    return (await res.json()) as StartSessionRes;
  }

  async send(sessionId: string, req: SendMessageReq, h: ChatEventHandlers, signal?: AbortSignal) {
    return this.stream(
      `/v1/child/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
      req,
      h,
      signal,
    );
  }

  async retry(sessionId: string, messageId: string, h: ChatEventHandlers, signal?: AbortSignal) {
    return this.stream(
      `/v1/child/chat/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/reply`,
      {},
      h,
      signal,
    );
  }

  private async stream(path: string, body: object, h: ChatEventHandlers, signal?: AbortSignal) {
    const init: RequestInit = {
      method: 'POST',
      headers: { Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;
    const res = await childFetch(path, init);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      h.onError(new ChildApiError(body?.error?.code ?? 'REQUEST_FAILED', res.status));
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const ev of parsed.events) {
          dispatch(ev, h);
          if (ev.event === 'done' || ev.event === 'crisis' || ev.event === 'review')
            completed = true;
        }
      }
      if (!completed && !signal?.aborted) h.onError(new Error('stream interrupted'));
    } finally {
      reader.releaseLock();
    }
  }
}

const MOCK_REPLIES: Record<string, { text: string; actions?: PetAction[] }> = {
  default: {
    text: 'へえ、そうなんだ！ もっと きかせて。',
    actions: [{ type: 'set_expression', expression: 'together' }],
  },
  happy: {
    text: 'わあ、いいね！ それで それで？',
    actions: [{ type: 'set_expression', expression: 'celebrate' }],
  },
  sad: {
    text: 'そっか…それは いやだったね。となりに いるよ。',
    actions: [
      { type: 'set_expression', expression: 'caring' },
      { type: 'quick_replies', options: ['きいて ほしい', 'ほかの はなし', 'いまは いい'] },
    ],
  },
  bullied: {
    text: 'それは とても つらかったね。はなしてくれて ありがとう。このこと、おとなに つたえるのは どう？',
    actions: [
      { type: 'set_expression', expression: 'worried' },
      { type: 'offer_tell_adult', consultationId: 'cs_mock' },
    ],
  },
};

export class MockChatClient implements ChatClient {
  async startSession(): Promise<StartSessionRes> {
    return { sessionId: `mock_${Date.now()}`, openingMessage: 'やあ！きょうは なに してた？' };
  }

  async send(_sessionId: string, req: SendMessageReq, h: ChatEventHandlers, signal?: AbortSignal) {
    const text = req.text;
    if (/死にたい|消えたい|しにたい|きえたい/.test(text)) {
      h.onMeta(`m_${Date.now()}`, true);
      h.onCrisis({
        crisisId: 'cr_mock',
        message:
          '話してくれてありがとう。あなたの安全がいちばん大事だよ。近くの安全な大人に、助けを求めてね。',
        resources: [],
      });
      return;
    }
    const key = /無視|むし|ハブ|なぐ|たた|いじめ/.test(text)
      ? 'bullied'
      : /つらい|かなしい|いや|こわい|泣/.test(text)
        ? 'sad'
        : /たのし|うれし|やった|すき/.test(text)
          ? 'happy'
          : 'default';
    const reply = MOCK_REPLIES[key]!;
    h.onMeta(`m_${Date.now()}`, false);
    await sleep(350, signal);
    for (const piece of reply.text.split(/(?<=[。？！])/)) {
      if (signal?.aborted) return;
      h.onDelta(piece);
      await sleep(260, signal);
    }
    for (const a of reply.actions ?? []) h.onAction(a);
    h.onDone(`m_${Date.now() + 1}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export function createChatClient(): ChatClient {
  return process.env.NEXT_PUBLIC_CHAT_MODE === 'mock' ? new MockChatClient() : new ApiChatClient();
}
