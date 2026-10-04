import type { TurnChunk, TurnReq } from '@ijime/api-types';
import { cloudRunIdToken } from '@ijime/service-kit';
import type { Hono } from 'hono';

export interface PetAgentClient {
  turn(req: TurnReq, signal?: AbortSignal): AsyncIterable<TurnChunk>;
}

async function* readNdjson(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as TurnChunk;
      nl = buffer.indexOf('\n');
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as TurnChunk;
}

export class HttpPetAgentClient implements PetAgentClient {
  constructor(
    private readonly baseUrl: string,
    private readonly idToken?: () => Promise<string | undefined>,
  ) {}

  async *turn(req: TurnReq, signal?: AbortSignal): AsyncIterable<TurnChunk> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await this.idToken?.();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const init: RequestInit = { method: 'POST', headers, body: JSON.stringify(req) };
    if (signal) init.signal = signal;
    const res = await fetch(`${this.baseUrl}/internal/turns`, init);
    if (!res.ok || !res.body) throw new Error(`pet-agent ${res.status}`);
    yield* readNdjson(res.body);
  }
}

export class AppPetAgentClient implements PetAgentClient {
  constructor(private readonly app: Hono<never>) {}

  async *turn(req: TurnReq, signal?: AbortSignal): AsyncIterable<TurnChunk> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    };
    if (signal) init.signal = signal;
    const res = await this.app.request('/internal/turns', init);
    if (!res.ok || !res.body) throw new Error(`pet-agent ${res.status}`);
    yield* readNdjson(res.body);
  }
}

// pet-agent は内部トラフィックだけを受け付け、呼び出し元の ID を要求する：本番環境では pet-agent の URL を audience とする ID トークンを付ける
export function petAgentClientFromEnv(prod: boolean): PetAgentClient {
  const url = process.env['PET_AGENT_URL'] ?? 'http://localhost:8082';
  return new HttpPetAgentClient(url, prod ? cloudRunIdToken(url) : undefined);
}
