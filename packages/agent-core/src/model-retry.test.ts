import { Gemini, InMemorySessionService, type LlmResponse } from '@google/adk';
import { FinishReason } from '@google/genai';
import type { PetAction, TurnChunk } from '@ijime/api-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGemini, createPetAgent } from './agent.js';
import * as core from './agent.js';
import { PET_APP_NAME } from './firestore-session.js';
import { OutputFilter } from './output-filter.js';
import { disableAdkContentCapture } from './telemetry.js';
import { createPetTools, type PetToolExecutor } from './tools.js';
import { runPetTurn, type TurnInput } from './turn.js';

const { countModelCalls } = await import(
  new URL('../../../scripts/manual-preview.mjs', import.meta.url).href
);

const reply: LlmResponse = {
  content: { role: 'model', parts: [{ text: 'そっか。' }] },
  turnComplete: true,
};
const transient = () => Object.assign(new Error('provider echoed PRIVATE_TEXT'), { status: 503 });

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function run(opts: Partial<TurnInput> = {}) {
  const sessionService = opts.sessionService ?? new InMemorySessionService();
  await sessionService.createSession({ appName: PET_APP_NAME, userId: 'c', sessionId: 's' });
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  const actions: PetAction[] = [];
  const recordMood = vi.fn(async () => {});
  const tools = createPetTools(
    { recordMood } as unknown as PetToolExecutor,
    { childId: 'c', sessionId: 's', gradeBand: 'high', characterId: 'moko' },
    (action) => actions.push(action),
  );
  const agent = createPetAgent({
    model: createGemini('petChat', { projectId: 'test-project' }),
    instruction: 'PRIVATE_INSTRUCTION',
    tools,
  });
  const chunks: TurnChunk[] = [];
  const gen = runPetTurn({
    agent,
    sessionService,
    childId: 'c',
    sessionId: 's',
    text: 'PRIVATE_TEXT',
    gradeBand: 'high',
    filter: new OutputFilter({ rules: [{ id: 'blocked', label_ja: 'x', patterns: ['BLOCKED'] }] }),
    safeReply: 'SAFE',
    actions,
    onLog: (event, fields) => logs.push({ event, fields }),
    ...opts,
  });
  let next = await gen.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await gen.next();
  }
  const session = await sessionService.getSession({
    appName: PET_APP_NAME,
    userId: 'c',
    sessionId: 's',
  });
  return { outcome: next.value, chunks, logs, session: session!, recordMood };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('GEMINI_MODEL_PET_CHAT', 'gemini-2.5-flash');
  disableAdkContentCapture();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('pet model request retry, not Agent replay', () => {
  it('retries an explicitly normal empty completion after tools without replaying them', async () => {
    let calls = 0;
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(async function* () {
      if (++calls === 1) {
        yield {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'record_mood', args: { weather: 'sunny' } } }],
          },
          turnComplete: true,
        };
      } else if (calls === 2) yield { finishReason: FinishReason.STOP, partial: false };
      else yield reply;
    });
    const result = await run();
    expect(result.outcome.fallback).toBeNull();
    expect(result.recordMood).toHaveBeenCalledTimes(1);
    expect(calls).toBe(3);
    expect(result.logs).toContainEqual(
      expect.objectContaining({
        event: 'agent.model_request',
        fields: expect.objectContaining({
          requestPhase: 'after_tool',
          reason: 'empty_normal_completion',
          retrying: true,
        }),
      }),
    );
    expect(
      result.session.events.filter(
        (event) => event.content?.role === 'user' && event.content.parts?.some((part) => part.text),
      ),
    ).toHaveLength(1);
  });

  it.each([
    {},
    { finishReason: FinishReason.SAFETY },
    { finishReason: FinishReason.STOP, errorCode: 'SAFETY' },
    { finishReason: FinishReason.STOP, interrupted: true },
  ] as LlmResponse[])(
    'does not retry an empty completion without unambiguous normal termination: %j',
    async (response) => {
      const generate = vi
        .spyOn(Gemini.prototype, 'generateContentAsync')
        .mockImplementation(async function* () {
          yield response;
        });
      expect((await run()).outcome.fallback).toBe('SAFE');
      expect(generate).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds repeated normal empty completions to two attempts', async () => {
    const generate = vi
      .spyOn(Gemini.prototype, 'generateContentAsync')
      .mockImplementation(async function* () {
        yield { finishReason: FinishReason.STOP };
      });
    expect((await run()).outcome.fallback).toBe('SAFE');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not retry a normal trailing metadata chunk after visible text', async () => {
    const generate = vi
      .spyOn(Gemini.prototype, 'generateContentAsync')
      .mockImplementation(async function* () {
        yield reply;
        yield { finishReason: FinishReason.STOP };
      });
    expect((await run()).outcome.replyText).toBe('そっか。');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('preserves the first-response budget through the real preview wrapper and counts both attempts', async () => {
    let calls = 0;
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(
      async function* (_request, _stream, signal) {
        await wait(++calls === 1 ? 60000 : 1000, signal);
        yield reply;
      },
    );
    const counter = { modelCalls: 0 };
    const model = countModelCalls(
      createGemini('petChat', { projectId: 'test-project' }),
      counter,
      new AbortController().signal,
      core.inheritModelRequestScope,
    );
    const agent = createPetAgent({ model, instruction: 'x', tools: [] });
    const running = run({ agent });
    await vi.advanceTimersByTimeAsync(16000);
    const callsAt16Seconds = calls;
    await vi.advanceTimersByTimeAsync(14000);
    const result = await running;
    expect(callsAt16Seconds).toBe(2);
    expect(result.outcome.fallback).toBeNull();
    expect(counter.modelCalls).toBe(2);
    expect(result.logs).toContainEqual(
      expect.objectContaining({
        event: 'agent.model_request',
        fields: expect.objectContaining({
          attempt: 1,
          reason: 'first_response_timeout',
          retrying: true,
        }),
      }),
    );
    expect(result.session.events.filter((event) => event.content?.role === 'user')).toHaveLength(1);
  });

  it('counts request retries after a tool result without replaying the tool under the preview wrapper', async () => {
    let calls = 0;
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(async function* () {
      if (++calls === 1) {
        yield {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'record_mood', args: { weather: 'sunny' } } }],
          },
          turnComplete: true,
        };
      } else if (calls === 2) throw transient();
      else yield reply;
    });
    const recordMood = vi.fn(async () => {});
    const tools = createPetTools(
      { recordMood } as unknown as PetToolExecutor,
      { childId: 'c', sessionId: 's', gradeBand: 'high', characterId: 'moko' },
      () => {},
    );
    const counter = { modelCalls: 0 };
    const model = countModelCalls(
      createGemini('petChat', { projectId: 'test-project' }),
      counter,
      new AbortController().signal,
      core.inheritModelRequestScope,
    );
    const result = await run({ agent: createPetAgent({ model, instruction: 'x', tools }) });
    expect(result.outcome.fallback).toBeNull();
    expect(counter.modelCalls).toBe(3);
    expect(recordMood).toHaveBeenCalledTimes(1);
  });

  it('isolates concurrent turns through the preview wrapper on a shared model', async () => {
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(
      async function* (_request, _stream, signal) {
        await wait(30, signal);
        yield reply;
      },
    );
    const counter = { modelCalls: 0 };
    const model = countModelCalls(
      createGemini('petChat', { projectId: 'test-project' }),
      counter,
      new AbortController().signal,
      core.inheritModelRequestScope,
    );
    const agent = createPetAgent({ model, instruction: 'x', tools: [] });
    const short = run({ agent, firstTokenTimeoutMs: 10, turnTimeoutMs: 100 });
    const long = run({ agent, firstTokenTimeoutMs: 50, turnTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(30);
    expect((await short).outcome.fallback).toBe('SAFE');
    expect((await long).outcome.fallback).toBeNull();
    expect(counter.modelCalls).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ status: 503 }, { status: 429 }, { cause: { code: 'ECONNRESET' } }])(
    'retries a transient failure once before output: %j',
    async (failure) => {
      let calls = 0;
      const generate = vi
        .spyOn(Gemini.prototype, 'generateContentAsync')
        .mockImplementation(async function* () {
          if (++calls === 1) throw Object.assign(transient(), { status: undefined }, failure);
          yield reply;
        });
      const result = await run();
      expect(result.outcome.fallback).toBeNull();
      expect(generate).toHaveBeenCalledTimes(2);
      expect(result.session.events.filter((event) => event.content?.role === 'user')).toHaveLength(
        1,
      );
      expect(result.session.events.filter((event) => event.content?.role === 'model')).toHaveLength(
        1,
      );
      expect(result.chunks.at(-1)).not.toHaveProperty('retryable');
    },
  );

  it('retries a 15s first-response timeout without cancelling the turn', async () => {
    let calls = 0;
    const signals: AbortSignal[] = [];
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(
      async function* (_request, _stream, signal) {
        signals.push(signal!);
        await wait(++calls === 1 ? 16000 : 1000, signal);
        yield reply;
      },
    );
    const running = run();
    await vi.advanceTimersByTimeAsync(16000);
    const result = await running;
    expect(result.outcome.fallback).toBeNull();
    expect(calls).toBe(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result.logs).toContainEqual(
      expect.objectContaining({
        event: 'agent.model_request',
        fields: expect.objectContaining({
          attempt: 1,
          reason: 'first_response_timeout',
          retrying: true,
        }),
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends persistent timeouts at the original 30s turn deadline with no third attempt', async () => {
    const generate = vi
      .spyOn(Gemini.prototype, 'generateContentAsync')
      .mockImplementation(async function* (_request, _stream, signal) {
        await wait(60000, signal);
        yield reply;
      });
    let finished = false;
    const running = run().then((result) => {
      finished = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(29999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await running;
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.outcome.fallback).toBe('SAFE');
    expect(result.chunks.at(-1)).toMatchObject({ type: 'done', retryable: true });
    expect(result.logs).toContainEqual(
      expect.objectContaining({
        event: 'agent.model_request',
        fields: expect.objectContaining({ attempt: 2, reason: 'turn_timeout', retrying: false }),
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains an aborted request before starting its retry', async () => {
    const order: string[] = [];
    let calls = 0;
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(
      async function* (_request, _stream, signal) {
        order.push(`start${++calls}`);
        if (calls === 1) {
          try {
            await wait(60000, signal);
          } finally {
            await wait(500);
            order.push('drained1');
          }
        }
        yield reply;
      },
    );
    const running = run();
    await vi.advanceTimersByTimeAsync(15001);
    expect(order).toEqual(['start1']);
    await vi.advanceTimersByTimeAsync(499);
    expect((await running).outcome.fallback).toBeNull();
    expect(order).toEqual(['start1', 'drained1', 'start2']);
  });

  it.each([
    { text: 'そっか。' },
    { text: 'not a complete sentence' },
    { text: 'PRIVATE_THOUGHT', thought: true },
    { functionCall: { name: 'record_mood', args: { weather: 'sunny' } } },
  ])('never retries after any text or functionCall was yielded: %j', async (part) => {
    const generate = vi
      .spyOn(Gemini.prototype, 'generateContentAsync')
      .mockImplementation(async function* () {
        yield { content: { role: 'model', parts: [part] }, partial: true };
        throw transient();
      });
    const result = await run();
    expect(generate).toHaveBeenCalledTimes(1);
    if ('functionCall' in part) expect(result.chunks.at(-1)).not.toHaveProperty('retryable', true);
  });

  it('retries only the request after a tool response, preserving one tool execution and user message', async () => {
    let calls = 0;
    const phases: boolean[] = [];
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(
      async function* (request) {
        phases.push(
          request.contents.some((content) => content.parts?.some((part) => part.functionResponse)),
        );
        if (++calls === 1) {
          yield {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'record_mood', args: { weather: 'sunny' } } }],
            },
            turnComplete: true,
          };
        } else if (calls === 2) throw transient();
        else yield reply;
      },
    );
    const result = await run();
    expect(result.outcome.fallback).toBeNull();
    expect(phases).toEqual([false, true, true]);
    expect(result.recordMood).toHaveBeenCalledTimes(1);
    expect(
      result.session.events.filter((event) =>
        event.content?.parts?.some((part) => part.text === 'PRIVATE_TEXT'),
      ),
    ).toHaveLength(1);
    expect(result.logs).toContainEqual(
      expect.objectContaining({
        event: 'agent.model_request',
        fields: expect.objectContaining({ requestPhase: 'after_tool', attempt: 1, retrying: true }),
      }),
    );
  });

  it('does not authorize a saved-message retry after a tool even if its following requests fail', async () => {
    let calls = 0;
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(async function* () {
      if (++calls > 1) throw transient();
      yield {
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'record_mood', args: { weather: 'sunny' } } }],
        },
        turnComplete: true,
      };
    });
    const result = await run();
    expect(calls).toBe(3);
    expect(result.recordMood).toHaveBeenCalledTimes(1);
    expect(result.outcome.fallback).toBe('SAFE');
    expect(result.chunks.at(-1)).not.toHaveProperty('retryable', true);
  });

  it('does not authorize retry after an action even without a tool event', async () => {
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(async function* () {
      throw transient();
      yield reply;
    });
    const result = await run({ actions: [{ type: 'set_expression', expression: 'together' }] });
    expect(result.outcome.fallback).toBe('SAFE');
    expect(result.chunks.at(-1)).not.toHaveProperty('retryable', true);
  });

  it('does not authorize retry after uncertain persistence', async () => {
    const sessionService = new InMemorySessionService();
    const append = sessionService.appendEvent.bind(sessionService);
    sessionService.appendEvent = async (request) => {
      if (request.event.content?.role === 'user') throw new Error('write failed');
      return append(request);
    };
    const generate = vi.spyOn(Gemini.prototype, 'generateContentAsync');
    const result = await run({ sessionService });
    expect(generate).not.toHaveBeenCalled();
    expect(result.outcome.fallback).toBe('SAFE');
    expect(result.chunks.at(-1)).not.toHaveProperty('retryable', true);
  });

  it('waits for fallback persistence before granting retry permission', async () => {
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(async function* () {
      throw transient();
      yield reply;
    });
    const sessionService = new InMemorySessionService();
    const append = sessionService.appendEvent.bind(sessionService);
    let written = false;
    sessionService.appendEvent = async (request) => {
      if (request.event.content?.role === 'model') {
        await wait(500);
        written = true;
      }
      return append(request);
    };
    let finished = false;
    const running = run({ sessionService }).then((result) => {
      finished = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(finished).toBe(false);
    expect(written).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await running).chunks.at(-1)).toMatchObject({ type: 'done', retryable: true });
    expect(written).toBe(true);
  });

  it('does not retry model safety/error events', async () => {
    const generate = vi
      .spyOn(Gemini.prototype, 'generateContentAsync')
      .mockImplementation(async function* () {
        yield { errorCode: 'SAFETY', errorMessage: 'PRIVATE_PROVIDER_MESSAGE' };
      });
    const result = await run();
    expect(result.outcome.fallback).toBe('SAFE');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.logs)).not.toContain('PRIVATE_');
    expect(result.logs).toContainEqual(
      expect.objectContaining({
        event: 'agent.model_request',
        fields: expect.objectContaining({ reason: 'model_event_error', retrying: false }),
      }),
    );
  });

  it('keeps deadlines separate for concurrent turns sharing one model', async () => {
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(
      async function* (_request, _stream, signal) {
        await wait(30, signal);
        yield reply;
      },
    );
    const agent = createPetAgent({
      model: createGemini('petChat', { projectId: 'test-project' }),
      instruction: 'x',
      tools: [],
    });
    const short = run({ agent, firstTokenTimeoutMs: 10, turnTimeoutMs: 100 });
    const long = run({ agent, firstTokenTimeoutMs: 50, turnTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(30);
    expect((await short).outcome.fallback).toBe('SAFE');
    expect((await long).outcome.replyText).toBe('そっか。');
    expect((await long).outcome.fallback).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry unknown errors or assume a quota cause', async () => {
    const generate = vi
      .spyOn(Gemini.prototype, 'generateContentAsync')
      .mockImplementation(async function* () {
        throw new Error('PRIVATE quota speculation');
        yield reply;
      });
    const result = await run();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.logs).toContainEqual(
      expect.objectContaining({
        event: 'agent.model_request',
        fields: expect.objectContaining({
          reason: 'unknown_error',
          httpStatus: null,
          retrying: false,
        }),
      }),
    );
    expect(JSON.stringify(result.logs)).not.toMatch(/PRIVATE|quota/);
  });

  it('does not start a retry when cancellation happens during request cleanup', async () => {
    const controller = new AbortController();
    const generate = vi
      .spyOn(Gemini.prototype, 'generateContentAsync')
      .mockImplementation(async function* (_request, _stream, signal) {
        try {
          await wait(60000, signal);
        } finally {
          await wait(500);
        }
        yield reply;
      });
    const running = run({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(15001);
    controller.abort();
    await vi.advanceTimersByTimeAsync(499);
    expect((await running).chunks).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not grant a fresh 30s budget after a late tool call', async () => {
    let calls = 0;
    const limits: number[] = [];
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(
      async function* (request, _stream, signal) {
        limits.push(request.config!.httpOptions!.timeout!);
        if (++calls === 1) {
          await wait(14000, signal);
          yield {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'record_mood', args: { weather: 'sunny' } } }],
            },
            turnComplete: true,
          };
        } else {
          await wait(60000, signal);
          yield reply;
        }
      },
    );
    const running = run();
    await vi.advanceTimersByTimeAsync(30000);
    const result = await running;
    expect(limits).toEqual([30000, 16000, 1000]);
    expect(result.recordMood).toHaveBeenCalledTimes(1);
    expect(result.outcome.fallback).toBe('SAFE');
    expect(result.chunks.at(-1)).not.toHaveProperty('retryable', true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 100, 15100])(
    'cancels without retry, fallback persistence, or done at %i ms',
    async (at) => {
      const controller = new AbortController();
      const generate = vi
        .spyOn(Gemini.prototype, 'generateContentAsync')
        .mockImplementation(async function* (_request, _stream, signal) {
          await wait(60000, signal);
          yield reply;
        });
      if (at === 0) controller.abort();
      const running = run({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(at);
      controller.abort();
      const result = await running;
      expect(generate).toHaveBeenCalledTimes(at === 0 ? 0 : at > 15000 ? 2 : 1);
      expect(result.chunks.some((chunk) => chunk.type === 'done' || chunk.type === 'delta')).toBe(
        false,
      );
      expect(result.session.events.filter((event) => event.content?.role === 'model')).toHaveLength(
        0,
      );
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([400, 401, 403])('does not retry a permanent HTTP %i error', async (status) => {
    const generate = vi
      .spyOn(Gemini.prototype, 'generateContentAsync')
      .mockImplementation(async function* () {
        throw Object.assign(transient(), { status });
        yield reply;
      });
    expect((await run()).outcome.fallback).toBe('SAFE');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('keeps filtering after a successful retry and never persists blocked text', async () => {
    let calls = 0;
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(async function* () {
      if (++calls === 1) throw transient();
      yield { content: { role: 'model', parts: [{ text: 'BLOCKED。' }] }, turnComplete: true };
    });
    const result = await run();
    expect(result.outcome.replyText).toBe('SAFE');
    expect(JSON.stringify(result.session.events)).not.toContain('BLOCKED');
    expect(calls).toBe(2);
  });

  it('logs only allowlisted phase/status diagnostics, never provider text or request contents', async () => {
    let calls = 0;
    vi.spyOn(Gemini.prototype, 'generateContentAsync').mockImplementation(async function* () {
      if (++calls === 1)
        throw Object.assign(transient(), {
          code: 'PRIVATE_CODE',
          requestId: 'PRIVATE_ID',
          url: 'https://secret/PRIVATE_URL',
          details: { authorization: 'PRIVATE_TOKEN' },
          cause: new Error('PRIVATE_CAUSE'),
        });
      yield reply;
    });
    const { logs } = await run();
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'agent.model_request',
        fields: expect.objectContaining({
          requestPhase: 'initial',
          phase: 'awaiting_response',
          status: 'failed',
          httpStatus: 503,
          retrying: true,
        }),
      }),
    );
    expect(JSON.stringify(logs)).not.toMatch(/PRIVATE_|provider echoed|そっか/);
    expect(
      logs
        .filter((entry) => entry.event === 'agent.model_request')
        .every(({ fields }) =>
          Object.keys(fields).every((key) =>
            [
              'request',
              'requestPhase',
              'purpose',
              'attempt',
              'phase',
              'status',
              'reason',
              'httpStatus',
              'transportCode',
              'elapsedMs',
              'remainingMs',
              'retrying',
              'emitted',
            ].includes(key),
          ),
        ),
    ).toBe(true);
  });
});
