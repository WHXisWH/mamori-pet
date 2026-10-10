import type { PetToolExecutor, TurnContext } from '@ijime/agent-core';
import type { CrisisHitCategory, ToolCallReq, ToolCallRes } from '@ijime/api-types';
import { voice as voiceConfig } from '@ijime/config';

export type ToolCaller = (toolName: string, req: ToolCallReq) => Promise<unknown>;

// pet-agent の POST /internal/tools/{toolName}。記憶や作品などのデータは pet-agent 側でだけ読み書きする
export function httpToolCaller(
  baseUrl: string,
  idToken?: () => Promise<string | undefined>,
  fetchImpl: typeof fetch = fetch,
): ToolCaller {
  return async (toolName, req) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = await idToken?.();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetchImpl(`${baseUrl}/internal/tools/${encodeURIComponent(toolName)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(voiceConfig.toolCallTimeoutMs),
    });
    if (!res.ok) throw new Error(`pet-agent tool ${toolName} responded ${res.status}`);
    return ((await res.json()) as ToolCallRes).result;
  };
}

// 音声モードのツール実行器：すべて pet-agent に転送する。escalate_crisis だけはローカルで危機の中断処理を行う
export function forwardingExecutor(
  call: ToolCaller,
  escalate: (category: CrisisHitCategory) => Promise<{ crisisId: string }>,
  mayWrite: () => boolean,
): PetToolExecutor {
  const req = (ctx: TurnContext, args: Record<string, unknown>): ToolCallReq => ({
    childId: ctx.childId,
    sessionId: ctx.sessionId,
    args,
    ...(ctx.operationId ? { operationId: ctx.operationId } : {}),
  });
  const write = (toolName: string, ctx: TurnContext, args: Record<string, unknown>) => {
    if (!mayWrite()) throw new Error('voice_safety_check_pending');
    return call(toolName, req(ctx, args));
  };
  return {
    getChildContext: async (ctx) => (await call('get_child_context', req(ctx, {}))) as never,
    searchSkill: async (ctx, query) =>
      ((await call('search_skill', req(ctx, { query }))) as { passages: string[] }).passages,
    recordMood: async (ctx, weather) => {
      await write('record_mood', ctx, { weather });
    },
    remember: async (ctx, content, category) =>
      (await write('remember', ctx, { content, category })) as Awaited<
        ReturnType<PetToolExecutor['remember']>
      >,
    recall: async (ctx, topic) =>
      ((await call('recall', req(ctx, { topic }))) as { memories: string[] }).memories,
    suggestGame: async (ctx, type) => {
      const result = await write('suggest_game', ctx, { type });
      return typeof result === 'object' && result !== null && 'ok' in result && result.ok === true;
    },
    startTellAdult: async (ctx, reason) =>
      (await write('start_tell_adult', ctx, reason === undefined ? {} : { reason })) as {
        consultationId: string;
      },
    escalateCrisis: (_ctx, category) => escalate(category),
  };
}
