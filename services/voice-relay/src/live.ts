import {
  Gemini,
  LiveRequestQueue,
  Runner,
  type BaseLlmConnection,
  type BaseSessionService,
  type Event,
  type LlmAgent,
  type LlmRequest,
} from '@google/adk';
import { Modality } from '@google/genai';
import { assertAdkContentCaptureDisabled, PET_APP_NAME } from '@ijime/agent-core';
import { isLocalManualPreview, REGION, resolveModelId, voice as voiceConfig } from '@ijime/config';

import availability from './live-availability.json' with { type: 'json' };

// ADK runLive のイベントを、セッション層が必要とする種類に絞り込む。メモリ上を流れるだけで、ディスクにもログにも残さない。
export type LiveEvent =
  | { type: 'child_partial'; text: string }
  | { type: 'child_final'; text: string }
  | { type: 'pet_partial'; text: string }
  | { type: 'pet_final'; text: string }
  | { type: 'pet_audio'; data: Buffer }
  | { type: 'interrupted' }
  | { type: 'turn_complete' }
  | { type: 'error'; code: string };

export interface LiveSession {
  readonly events: AsyncIterable<LiveEvent>;
  sendAudio(pcm: Buffer): void;
  close(): Promise<void>;
}

export class LiveConnectError extends Error {
  constructor() {
    super('live connect failed or timed out');
    this.name = 'LiveConnectError';
  }
}

export class LiveUnavailableError extends LiveConnectError {
  constructor(
    readonly code: 'tokyo_required' | 'live_tokyo_unavailable' | 'live_model_unverified',
  ) {
    super();
    this.name = 'LiveUnavailableError';
    this.message = code;
  }
}

// 音声セッションごとに1インスタンス：接続の確立をセッション層に知らせる。セッション再開を有効にし、ADK は goAway を受け取るとハンドルを使って自動で再接続する
export class ResumableGemini extends Gemini {
  private markConnected!: () => void;
  readonly connected = new Promise<void>((r) => (this.markConnected = r));

  constructor(target: { projectId: string; location?: string }) {
    assertAdkContentCaptureDisabled();
    const location = target.location ?? REGION;
    if (location !== REGION && !isLocalManualPreview())
      throw new LiveUnavailableError('tokyo_required');
    const model = resolveModelId('petVoice');
    const reviewed = availability.models.find((entry) => entry.id === model);
    if (!reviewed) throw new LiveUnavailableError('live_model_unverified');
    if (!reviewed.regions.includes(location))
      throw new LiveUnavailableError('live_tokyo_unavailable');
    super({
      model,
      vertexai: true,
      project: target.projectId,
      location,
    });
  }

  override async connect(req: LlmRequest): Promise<BaseLlmConnection> {
    req.liveConnectConfig ??= {};
    req.liveConnectConfig.sessionResumption ??= {};
    const conn = await super.connect(req);
    this.markConnected();
    return conn;
  }
}

export class Pipe<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((v: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }

  close(): void {
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

export function toLiveEvents(ev: Event): LiveEvent[] {
  if (ev.errorCode || ev.errorMessage) return [{ type: 'error', code: ev.errorCode ?? 'unknown' }];
  const out: LiveEvent[] = [];
  const input = ev.inputTranscription;
  if (input?.text)
    out.push({ type: input.finished ? 'child_final' : 'child_partial', text: input.text });
  const output = ev.outputTranscription;
  if (output?.text)
    out.push({ type: output.finished ? 'pet_final' : 'pet_partial', text: output.text });
  if (ev.content?.role === 'model' || ev.author !== 'user') {
    for (const p of ev.content?.parts ?? []) {
      const d = p.inlineData;
      if (d?.data && d.mimeType?.startsWith('audio/'))
        out.push({ type: 'pet_audio', data: Buffer.from(d.data, 'base64') });
    }
  }
  if (ev.interrupted) out.push({ type: 'interrupted' });
  if (ev.turnComplete) out.push({ type: 'turn_complete' });
  return out;
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref();
  });

// ADK runLive で Live セッションを確立する。connected は接続の確立時にモデルが解決する。タイムアウトや接続エラーでは LiveConnectError を投げる
export async function openAdkLive(input: {
  agent: LlmAgent;
  sessionService: BaseSessionService;
  childId: string;
  sessionId: string;
  connected: Promise<void>;
  connectTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<LiveSession> {
  if (input.signal?.aborted) throw new LiveConnectError();
  const runner = new Runner({
    appName: PET_APP_NAME,
    agent: input.agent,
    sessionService: input.sessionService,
  });
  const queue = new LiveRequestQueue();
  const abort = new AbortController();
  const pipe = new Pipe<LiveEvent>();
  const done = (async () => {
    try {
      for await (const ev of runner.runLive({
        userId: input.childId,
        sessionId: input.sessionId,
        liveRequestQueue: queue,
        runConfig: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          contextWindowCompression: { slidingWindow: {} },
        },
        abortSignal: abort.signal,
      }))
        for (const e of toLiveEvents(ev)) pipe.push(e);
    } catch (err) {
      pipe.push({ type: 'error', code: err instanceof Error ? err.name : 'unknown' });
    } finally {
      pipe.close();
    }
  })();

  let closing: Promise<void> | undefined;
  // 先にキューを閉じてから abort する：abort だけではアイドル中の受信ループが終了しない（adk-live.contract.test.ts を参照）
  const close = () =>
    (closing ??= (async () => {
      input.signal?.removeEventListener('abort', onAbort);
      queue.close();
      abort.abort();
      await Promise.race([done, sleep(2000)]);
      pipe.close();
    })());

  let markAborted!: (value: false) => void;
  const cancelled = new Promise<false>((resolve) => {
    markAborted = resolve;
  });
  const onAbort = () => {
    markAborted(false);
    void close();
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  const ok = await Promise.race([
    input.connected.then(() => true),
    done.then(() => false),
    sleep(input.connectTimeoutMs ?? voiceConfig.liveConnectTimeoutMs).then(() => false),
    cancelled,
  ]);
  if (!ok || input.signal?.aborted) {
    await close();
    throw new LiveConnectError();
  }

  return {
    events: pipe,
    sendAudio: (pcm) => {
      if (closing) return;
      queue.sendRealtime({
        mimeType: `audio/pcm;rate=${voiceConfig.inputSampleRateHz}`,
        data: pcm.toString('base64'),
      });
    },
    close,
  };
}
