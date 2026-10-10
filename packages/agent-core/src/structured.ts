import { InMemoryRunner, type LlmAgent } from '@google/adk';
import type { Part } from '@google/genai';

import { checkSchema, type JsonSchema } from './json-schema.js';
import { abortable } from './abortable.js';

// テキスト、またはテキストと画像などのマルチモーダルなパーツ（作品特徴抽出は inlineData で画像を渡す。メモリ上だけで扱う）
export type StructuredInput = string | Part[];

// quota：429 / RESOURCE_EXHAUSTED。呼び出し側はこれを見てバックオフ再試行とサーキットブレーカーを判断する
export type StructuredFailure = 'timeout' | 'quota' | 'model_error' | 'invalid_json' | 'schema';

export type StructuredResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; reason: StructuredFailure; attempts: number; path?: string };

export type StructuredOptions<T> = {
  schema: JsonSchema;
  timeoutMs: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  // schema 以外の業務上の検証（禁止語、長さなど）。false を返すと不合格として扱う
  accept?: (value: T) => boolean;
};

const QUOTA = /RESOURCE_EXHAUSTED|\b429\b/;

export function isQuotaError(code: unknown, message: unknown): boolean {
  return (
    String(code) === '429' ||
    String(code) === 'RESOURCE_EXHAUSTED' ||
    (typeof message === 'string' && QUOTA.test(message))
  );
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

async function once<T>(
  agent: LlmAgent,
  input: StructuredInput,
  opts: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  // セッションはこの呼び出しのメモリ上にだけ存在し、ディスクには書き込まない
  const runner = new InMemoryRunner({ agent, appName: `structured_${agent.name}` });
  const session = await runner.sessionService.createSession({
    appName: `structured_${agent.name}`,
    userId: 'structured',
  });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);
  if (opts.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let text = '';
  try {
    const events = runner.runAsync({
      userId: 'structured',
      sessionId: session.id,
      newMessage: { role: 'user', parts: typeof input === 'string' ? [{ text: input }] : input },
      abortSignal: controller.signal,
    });
    for await (const ev of abortable(events, controller.signal)) {
      if (ev.errorCode || ev.errorMessage)
        return {
          ok: false,
          reason: isQuotaError(ev.errorCode, ev.errorMessage) ? 'quota' : 'model_error',
          attempts: 1,
        };
      if (controller.signal.aborted) break;
      if (ev.content?.role === 'model' && !ev.partial)
        text =
          (ev.content.parts ?? [])
            .filter((p) => !p.thought)
            .map((p) => p.text ?? '')
            .join('') || text;
    }
  } catch (err) {
    const e = err as { status?: unknown; code?: unknown; message?: unknown } | undefined;
    return {
      ok: false,
      reason: controller.signal.aborted
        ? 'timeout'
        : isQuotaError(e?.status ?? e?.code, e?.message)
          ? 'quota'
          : 'model_error',
      attempts: 1,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (controller.signal.aborted) return { ok: false, reason: 'timeout', attempts: 1 };
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return { ok: false, reason: 'invalid_json', attempts: 1 };
  }
  const checked = checkSchema<T>(opts.schema, raw);
  if (!checked.ok) return { ok: false, reason: 'schema', attempts: 1, path: checked.path };
  if (opts.accept && !opts.accept(checked.value))
    return { ok: false, reason: 'schema', attempts: 1, path: 'accept' };
  return { ok: true, value: checked.value, attempts: 1 };
}

// ツールなしの LlmAgent を1回実行し、JSON を解析して kb の schema で検証する。不合格ならリトライする
export async function runStructured<T>(
  agent: LlmAgent,
  input: StructuredInput,
  opts: StructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const max = Math.max(1, opts.maxAttempts ?? 1);
  let last: StructuredResult<T> = { ok: false, reason: 'model_error', attempts: 0 };
  for (let i = 1; i <= max; i++) {
    if (opts.signal?.aborted) return { ok: false, reason: 'timeout', attempts: i - 1 };
    last = { ...(await once(agent, input, opts)), attempts: i };
    if (last.ok) return last;
  }
  return last;
}
