// 技術検証のオフライン部分：偽の Live 接続で ADK の本物の runLive を動かし、
// voice-relay が依存する挙動を固定する。@google/adk を更新してここが失敗したら、ゲートの実装を見直す。
import {
  BaseLlm,
  FunctionTool,
  InMemorySessionService,
  LiveRequestQueue,
  LlmAgent,
  Runner,
  type BaseLlmConnection,
  type Event,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { Modality, type Blob, type Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

class Pipe<T> {
  private items: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const r = await new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

class FakeConnection implements BaseLlmConnection {
  readonly realtime: Blob[] = [];
  readonly contents: Content[] = [];
  readonly server = new Pipe<LlmResponse>();
  closed = false;
  constructor(readonly request: LlmRequest) {}
  async sendHistory(): Promise<void> {}
  async sendContent(content: Content): Promise<void> {
    this.contents.push(content);
  }
  async sendRealtime(blob: Blob): Promise<void> {
    this.realtime.push(blob);
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    yield* this.server;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.server.close();
  }
}

class FakeLiveLlm extends BaseLlm {
  static override readonly supportedModels = [/^fake-live/];
  readonly connections: FakeConnection[] = [];
  constructor() {
    super({ model: 'fake-live' });
  }
  // eslint-disable-next-line require-yield
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error('live only');
  }
  override async connect(req: LlmRequest): Promise<BaseLlmConnection> {
    const c = new FakeConnection(req);
    this.connections.push(c);
    return c;
  }
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function setup() {
  const llm = new FakeLiveLlm();
  const toolCalls: unknown[] = [];
  const agent = new LlmAgent({
    name: 'pet_agent',
    model: llm,
    instruction: () => 'テスト用の指示',
    tools: [
      new FunctionTool({
        name: 'record_mood',
        description: 'mood',
        parameters: z.object({ weather: z.string() }),
        execute: async (args: unknown) => {
          toolCalls.push(args);
          return { ok: true };
        },
      }),
    ],
  });
  const sessions = new InMemorySessionService();
  const session = await sessions.createSession({ appName: 'pet', userId: 'c1' });
  const runner = new Runner({ appName: 'pet', agent, sessionService: sessions });
  const queue = new LiveRequestQueue();
  const abort = new AbortController();
  const events: Event[] = [];
  const done = (async () => {
    for await (const ev of runner.runLive({
      userId: 'c1',
      sessionId: session.id,
      liveRequestQueue: queue,
      runConfig: {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      abortSignal: abort.signal,
    }))
      events.push(ev);
  })().catch((e: unknown) => e);
  await until(() => llm.connections.length === 1);
  return {
    llm,
    conn: llm.connections[0]!,
    queue,
    abort,
    events,
    done,
    toolCalls,
    sessions,
    session,
  };
}

describe('ADK runLive contract', () => {
  it('opens the connection with transcription enabled and our instruction', async () => {
    const { conn, queue, abort, done } = await setup();
    const cfg = conn.request.liveConnectConfig;
    expect(cfg?.responseModalities).toEqual([Modality.AUDIO]);
    expect(cfg?.inputAudioTranscription).toEqual({});
    expect(cfg?.outputAudioTranscription).toEqual({});
    expect(JSON.stringify(conn.request.config?.systemInstruction)).toContain('テスト用の指示');
    queue.close();
    abort.abort();
    await done;
  });

  it('forwards realtime audio and surfaces transcripts, audio and interruptions as events', async () => {
    const { conn, queue, abort, events, done, sessions, session } = await setup();
    queue.sendRealtime({ mimeType: 'audio/pcm;rate=16000', data: 'AAAA' });
    await until(() => conn.realtime.length === 1);
    expect(conn.realtime[0]).toEqual({ mimeType: 'audio/pcm;rate=16000', data: 'AAAA' });

    conn.server.push({ inputTranscription: { text: 'こんにちは', finished: true } });
    conn.server.push({
      content: {
        role: 'model',
        parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'BBBB' } }],
      },
      partial: true,
    });
    conn.server.push({ outputTranscription: { text: 'やあ', finished: true } });
    conn.server.push({ interrupted: true });
    conn.server.push({ turnComplete: true });
    await until(() => events.some((e) => e.turnComplete));

    expect(events.find((e) => e.inputTranscription)?.inputTranscription?.text).toBe('こんにちは');
    expect(
      events.find((e) => e.content?.parts?.some((p) => p.inlineData))?.content?.parts?.[0]
        ?.inlineData?.data,
    ).toBe('BBBB');
    expect(events.find((e) => e.outputTranscription)?.outputTranscription?.text).toBe('やあ');
    expect(events.some((e) => e.interrupted)).toBe(true);

    // セッションサービスが受け取る内容：文字起こしは content ではなく transcription フィールドに入る（そのため FirestoreSessionService は保存しない）。
    // 音声チャンクはセッションサービスに渡らない。文字起こしは voice-relay 自身が危機検知のあとに書き込む。
    const stored = (await sessions.getSession({
      appName: 'pet',
      userId: 'c1',
      sessionId: session.id,
    }))!.events;
    expect(stored.map((e) => e.content?.parts?.length ?? 0)).toEqual([0, 0, 0, 0]);
    expect(stored.map((e) => e.inputTranscription?.text ?? e.outputTranscription?.text)).toEqual([
      'こんにちは',
      'やあ',
      undefined,
      undefined,
    ]);
    queue.close();
    abort.abort();
    await done;
  });

  it('executes tool calls in-process and returns the result over the connection', async () => {
    const { conn, queue, abort, done, toolCalls } = await setup();
    conn.server.push({
      content: {
        role: 'model',
        parts: [{ functionCall: { id: 't1', name: 'record_mood', args: { weather: 'sunny' } } }],
      },
    });
    await until(() => conn.contents.some((c) => c.parts?.some((p) => p.functionResponse)));
    expect(toolCalls).toEqual([{ weather: 'sunny' }]);
    const resp = conn.contents.flatMap((c) => c.parts ?? []).find((p) => p.functionResponse);
    expect(resp?.functionResponse).toMatchObject({ name: 'record_mood', response: { ok: true } });
    queue.close();
    abort.abort();
    await done;
  });

  it('ends when the queue is closed: the close request closes the connection', async () => {
    const { conn, queue, abort, done } = await setup();
    queue.close();
    await until(() => conn.closed);
    abort.abort();
    await done;
  });

  // abort だけでキューを閉じないと、アイドル中の受信ループは接続上で待ち続ける。abort してからキューを閉じても効かない（送信ループがすでに終了している）。
  // そのため voice-relay の終了処理は、必ず queue.close() のあとに abort する。
  it('does not end an idle run on abort alone', async () => {
    const { conn, queue, abort, done } = await setup();
    abort.abort();
    queue.close();
    const settled = await Promise.race([
      done.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 200)),
    ]);
    expect(settled).toBe(false);
    expect(conn.closed).toBe(false);
    await conn.close();
    await done;
  });
});
