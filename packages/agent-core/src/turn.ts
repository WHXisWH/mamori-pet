import { randomUUID } from 'node:crypto';
import {
  Runner,
  StreamingMode,
  createEvent,
  type AppendEventRequest,
  type BaseSessionService,
  type LlmAgent,
  type Session,
} from '@google/adk';
import type { GradeBand, PetAction, TurnChunk } from '@ijime/api-types';
import { agent as agentConfig } from '@ijime/config';

import { PET_APP_NAME } from './firestore-session.js';
import { truncateAtSentence, type OutputFilter } from './output-filter.js';
import { SENTENCE_SPLIT } from './scripted-llm.js';

export type TurnInput = {
  agent: LlmAgent;
  sessionService: BaseSessionService;
  childId: string;
  sessionId: string;
  text: string;
  gradeBand: GradeBand;
  filter: OutputFilter;
  safeReply: string;
  actions: PetAction[];
  firstTokenTimeoutMs?: number;
  turnTimeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (event: string, fields: Record<string, unknown>) => void;
};

export type TurnOutcome = {
  replyText: string;
  replyMessageId: string;
  fallback: string | null;
  toolCalls: string[];
};

export async function* runPetTurn(input: TurnInput): AsyncGenerator<TurnChunk, TurnOutcome> {
  const controller = new AbortController();
  let session: Session | undefined;
  let pendingReply: AppendEventRequest | undefined;
  // ADK persists before yielding. Defer final text so history contains only the filtered, actually sent reply.
  const sessionService = new Proxy(input.sessionService, {
    get(target, key) {
      if (key === 'appendEvent')
        return async (request: AppendEventRequest) => {
          session = request.session;
          if (
            request.event.content?.role === 'model' &&
            !request.event.content.parts?.some((part) => part.functionCall)
          ) {
            pendingReply = request;
            return request.event;
          }
          if (controller.signal.aborted) return request.event;
          return target.appendEvent(request);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const runner = new Runner({
    appName: PET_APP_NAME,
    agent: input.agent,
    sessionService,
  });
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort);
  if (input.signal?.aborted) controller.abort();
  const firstTokenMs = input.firstTokenTimeoutMs ?? agentConfig.firstTokenTimeoutMs;
  const turnMs = input.turnTimeoutMs ?? agentConfig.turnTimeoutMs;
  const started = Date.now();
  let firstModelEventMs: number | null = null;
  let firstVisibleTextMs: number | null = null;
  let firstTokenTimer: NodeJS.Timeout | undefined = setTimeout(
    () => controller.abort(),
    firstTokenMs,
  );
  const turnTimer = setTimeout(() => controller.abort(), turnMs);

  const toolCalls: string[] = [];
  let sent = '';
  let pending = '';
  let fallback: string | null = null;
  let replyMessageId = '';
  let emittedActions = 0;
  const maxChars = agentConfig.replyMaxChars[input.gradeBand];

  const flushActions = function* (): Generator<TurnChunk> {
    while (emittedActions < input.actions.length) {
      const action = input.actions[emittedActions]!;
      emittedActions += 1;
      const texts =
        action.type === 'quick_replies'
          ? action.options
          : action.type === 'memory_proposal'
            ? [action.text]
            : [];
      if (texts.every((text) => input.filter.check(text).ok)) yield { type: 'action', action };
      else input.onLog?.('filter.action', { blocked: true, type: action.type });
    }
  };

  try {
    const events = runner.runAsync({
      userId: input.childId,
      sessionId: input.sessionId,
      newMessage: { role: 'user', parts: [{ text: input.text }] },
      runConfig: {
        streamingMode: StreamingMode.SSE,
        maxLlmCalls: agentConfig.maxToolCallsPerTurn + 1,
      },
      abortSignal: controller.signal,
    });
    // Drain in-flight tool/storage work before returning: a Promise.race here would allow late writes after done.
    for await (const ev of events) {
      if (ev.errorCode || ev.errorMessage) {
        input.onLog?.('agent.turn_error', { error: 'model_event_error' });
        fallback = input.safeReply;
        controller.abort();
        break;
      }
      if (controller.signal.aborted) break;
      const parts = (ev.content?.parts ?? []).filter((p) => !p.thought);
      const modelProgress =
        ev.content?.role === 'model' && parts.some((p) => p.text || p.functionCall);
      if (modelProgress) firstModelEventMs ??= Date.now() - started;
      // A tool result starts another model request. Progress is not a user-visible first token.
      if (firstTokenTimer && (modelProgress || parts.some((p) => p.functionResponse))) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = setTimeout(() => controller.abort(), firstTokenMs);
      }
      for (const p of parts) if (p.functionCall?.name) toolCalls.push(p.functionCall.name);
      yield* flushActions();
      const text = parts.map((p) => p.text ?? '').join('');
      if (!ev.partial && !pendingReply?.event.partial && pendingReply?.event.id === ev.id)
        replyMessageId = ev.id;
      if (!text || ev.content?.role !== 'model') {
        continue;
      }
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = undefined;
      }
      if (ev.partial) {
        pending += text;
      } else {
        pending = text.startsWith(sent) ? text.slice(sent.length) : text;
      }
      const pieces = pending.split(SENTENCE_SPLIT);
      const complete = ev.partial ? pieces.slice(0, -1) : pieces;
      pending = ev.partial ? (pieces.at(-1) ?? '') : '';
      for (const sentence of complete) {
        if (!sentence) continue;
        const verdict = input.filter.check(sentence);
        if (!verdict.ok) {
          input.onLog?.('filter.output', { blocked: true, rule: verdict.ruleId });
          fallback = input.safeReply;
          controller.abort();
          break;
        }
        if (sent.length + sentence.length > maxChars) {
          const truncated = truncateAtSentence(sent + sentence, input.gradeBand).slice(sent.length);
          if (truncated) {
            sent += truncated;
            firstVisibleTextMs ??= Date.now() - started;
            yield { type: 'delta', text: truncated };
          }
          controller.abort();
          break;
        }
        sent += sentence;
        firstVisibleTextMs ??= Date.now() - started;
        yield { type: 'delta', text: sentence };
      }
      if (controller.signal.aborted) break;
    }
  } catch {
    if (!controller.signal.aborted || (!fallback && sent.length === 0)) {
      input.onLog?.('agent.turn_error', { error: 'generation_failed' });
      fallback = input.safeReply;
    }
  } finally {
    controller.abort();
    if (firstTokenTimer) clearTimeout(firstTokenTimer);
    clearTimeout(turnTimer);
    input.signal?.removeEventListener('abort', onAbort);
  }

  if (input.signal?.aborted)
    return { replyText: sent, replyMessageId: '', fallback: null, toolCalls };
  if (fallback) {
    if (sent.length === 0) yield { type: 'delta', text: fallback };
    else fallback = null;
  } else if (sent.length === 0) {
    fallback = input.safeReply;
    yield { type: 'delta', text: fallback };
  }
  const outcome: TurnOutcome = {
    replyText: sent || fallback || '',
    replyMessageId: fallback ? `fallback_${randomUUID()}` : replyMessageId || randomUUID(),
    fallback,
    toolCalls,
  };
  if (input.signal?.aborted) return { ...outcome, replyMessageId: '' };
  if (session) {
    await input.sessionService.appendEvent({
      session,
      event: createEvent({
        ...pendingReply?.event,
        id: outcome.replyMessageId,
        author: input.agent.name,
        invocationId: pendingReply?.event.invocationId ?? outcome.replyMessageId,
        content: { role: 'model', parts: [{ text: outcome.replyText }] },
        partial: false,
      }),
    });
  }
  if (input.signal?.aborted) return { ...outcome, replyMessageId: '' };
  input.onLog?.('agent.turn', {
    latencyMs: Date.now() - started,
    firstModelEventMs,
    firstVisibleTextMs,
    toolCalls: toolCalls.length,
    fallback: fallback !== null,
    replyChars: outcome.replyText.length,
  });
  yield { type: 'done', replyMessageId: outcome.replyMessageId };
  return outcome;
}
