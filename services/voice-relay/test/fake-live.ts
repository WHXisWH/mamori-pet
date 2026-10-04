import { BaseLlm, type BaseLlmConnection, type LlmRequest, type LlmResponse } from '@google/adk';
import type { Blob, Content } from '@google/genai';

import { Pipe } from '../src/live.js';

// 偽の Live 接続：テストが台本どおりにモデルの応答を server へ送り、受け取ったリアルタイム音声とツール結果を検査する
export class FakeConnection implements BaseLlmConnection {
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

export class FakeLiveLlm extends BaseLlm {
  static override readonly supportedModels = [/^fake-live/];
  readonly connections: FakeConnection[] = [];
  private markConnected!: () => void;
  readonly connected = new Promise<void>((r) => (this.markConnected = r));

  constructor(private readonly hang = false) {
    super({ model: 'fake-live' });
  }

  // eslint-disable-next-line require-yield
  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    throw new Error('live only');
  }

  override async connect(req: LlmRequest): Promise<BaseLlmConnection> {
    if (this.hang) await new Promise(() => {});
    const c = new FakeConnection(req);
    this.connections.push(c);
    this.markConnected();
    return c;
  }
}

export const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};
