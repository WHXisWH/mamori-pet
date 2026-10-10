import {
  Gemini,
  LlmAgent,
  type AfterModelCallback,
  type AfterToolCallback,
  type BaseLlm,
  type BeforeModelCallback,
  type BeforeToolCallback,
  type InstructionProvider,
  type LlmAgentConfig,
  type LlmRequest,
  type LlmResponse,
  type ToolUnion,
} from '@google/adk';
import { FinishReason, type Schema } from '@google/genai';
import {
  isLocalManualPreview,
  REGION,
  models,
  resolveModelId,
  type ModelPurpose,
} from '@ijime/config';

import { assertAdkContentCaptureDisabled } from './telemetry.js';

export type VertexTarget = { projectId: string; location?: string };

type ModelTurnBudget = {
  deadlineMs: number;
  firstResponseTimeoutMs: number;
  onLog?: (event: string, fields: Record<string, unknown>) => void;
  onToolCall: () => void;
};
type ModelRequestScope = {
  budget?: ModelTurnBudget & { requests: number };
  onAttempt?: () => void;
};
const modelRequestScopes = new WeakMap<AbortSignal, ModelRequestScope>();

// Bind to the invocation signal, never the shared model instance: concurrent children have separate budgets.
export function bindModelTurnBudget(
  model: BaseLlm,
  signal: AbortSignal,
  budget: ModelTurnBudget,
): (() => void) | undefined {
  if (!(model instanceof BoundedGemini) || model.purpose !== 'petChat') return undefined;
  modelRequestScopes.set(signal, { budget: { ...budget, requests: 0 } });
  return () => {
    modelRequestScopes.delete(signal);
  };
}

// Signal-composing wrappers explicitly forward the invocation scope and count actual SDK attempts.
export function inheritModelRequestScope(
  model: BaseLlm,
  upstream: AbortSignal | undefined,
  combined: AbortSignal,
  onAttempt: () => void,
): (() => void) | undefined {
  if (!(model instanceof BoundedGemini)) return undefined;
  const parent = upstream && modelRequestScopes.get(upstream);
  const previous = modelRequestScopes.get(combined);
  modelRequestScopes.set(combined, {
    ...parent,
    onAttempt: () => {
      parent?.onAttempt?.();
      onAttempt();
    },
  });
  return () => {
    if (previous) modelRequestScopes.set(combined, previous);
    else modelRequestScopes.delete(combined);
  };
}

function requestFailure(error: unknown) {
  const fields = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const status = fields['status'] ?? fields['statusCode'] ?? fields['code'];
  const httpStatus =
    typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null;
  const cause = fields['cause'];
  const code =
    fields['code'] ??
    (cause && typeof cause === 'object' ? (cause as Record<string, unknown>)['code'] : undefined);
  const transportCode =
    typeof code === 'string' &&
    [
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ECONNREFUSED',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(code)
      ? code
      : null;
  const timeout = fields['name'] === 'TimeoutError';
  return {
    httpStatus,
    transportCode,
    reason:
      httpStatus !== null
        ? 'http_error'
        : transportCode
          ? 'transport_error'
          : timeout
            ? 'transport_timeout'
            : 'unknown_error',
    transient:
      httpStatus !== null
        ? [408, 429, 500, 502, 503, 504].includes(httpStatus)
        : transportCode !== null || timeout,
  };
}

class BoundedGemini extends Gemini {
  constructor(
    readonly purpose: ModelPurpose,
    target: VertexTarget,
  ) {
    super({
      model: resolveModelId(purpose),
      vertexai: true,
      project: target.projectId,
      location: target.location ?? REGION,
    });
  }

  override async *generateContentAsync(
    request: LlmRequest,
    stream = false,
    signal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const config = request.config ?? {};
    const route = models[this.purpose];
    const timeoutMs = route.timeoutMs;
    const outputLimit = route.maxOutputTokens;
    // Only verified profiles use token budgets; newer model families need their own evaluation.
    // gemini-3.5-flash accepts the same thinkingBudget (measured in Tokyo 2026-10-03: default
    // thinking ~4-6s per call, budget 0 ~1.5s), so it shares the flash profile.
    const isFlash = /^gemini-(?:2\.5|3\.5)-flash(?:$|-)/.test(this.model);
    const isPro = /^gemini-2\.5-pro(?:$|-)/.test(this.model);
    const thinkingBudget = isPro
      ? Math.max(128, route.gemini25ThinkingBudget)
      : isFlash
        ? route.gemini25ThinkingBudget
        : undefined;
    request.config = {
      ...config,
      maxOutputTokens: Math.min(config.maxOutputTokens ?? outputLimit, outputLimit),
      ...(thinkingBudget === undefined
        ? {}
        : { thinkingConfig: { thinkingBudget, includeThoughts: false } }),
      httpOptions: {
        ...config.httpOptions,
        ...(timeoutMs === undefined
          ? {}
          : { timeout: Math.min(config.httpOptions?.timeout ?? timeoutMs, timeoutMs) }),
        retryOptions: { attempts: 1 },
      },
    };
    const scope = signal && modelRequestScopes.get(signal);
    const budget = scope?.budget;
    if (!budget) {
      signal?.throwIfAborted();
      scope?.onAttempt?.();
      yield* super.generateContentAsync(request, stream, signal);
      return;
    }
    const requestNumber = ++budget.requests;
    const requestPhase = request.contents.at(-1)?.parts?.some((part) => part.functionResponse)
      ? 'after_tool'
      : 'initial';
    // Retry only this model request, including its existing tool results. Never re-enter Runner.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal?.aborted || Date.now() >= budget.deadlineMs)
        throw new Error('model_turn_cancelled');
      const started = Date.now();
      const controller = new AbortController();
      let reason: string | null = null;
      let emitted = false;
      let completed = false;
      let failed = false;
      let retrying = false;
      let httpStatus: number | null = null;
      let transportCode: string | null = null;
      let emptyResponse: LlmResponse | undefined;
      let hasContent = false;
      let abnormalEnd = false;
      const abort = () => {
        reason ??= Date.now() >= budget.deadlineMs ? 'turn_timeout' : 'cancelled';
        controller.abort();
      };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => {
          reason ??= Date.now() >= budget.deadlineMs ? 'turn_timeout' : 'first_response_timeout';
          controller.abort();
        },
        Math.min(budget.firstResponseTimeoutMs, budget.deadlineMs - started),
      );
      const log = (status: string) =>
        budget.onLog?.('agent.model_request', {
          purpose: this.purpose,
          request: requestNumber,
          requestPhase,
          attempt,
          phase: emitted ? 'streaming' : 'awaiting_response',
          status,
          reason,
          httpStatus,
          transportCode,
          elapsedMs: Date.now() - started,
          remainingMs: Math.max(0, budget.deadlineMs - Date.now()),
          emitted,
          retrying,
        });
      log('started');
      try {
        const attemptRequest: LlmRequest = {
          ...request,
          contents: [...request.contents],
          config: {
            ...request.config,
            httpOptions: {
              ...request.config.httpOptions,
              timeout: Math.min(
                request.config.httpOptions?.timeout ?? Infinity,
                budget.deadlineMs - started,
              ),
            },
          },
        };
        // Await generator cleanup on failure/cancellation before retrying or returning. No detached race.
        controller.signal.throwIfAborted();
        scope?.onAttempt?.();
        for await (const response of super.generateContentAsync(
          attemptRequest,
          stream,
          controller.signal,
        )) {
          controller.signal.throwIfAborted();
          const parts = response.content?.parts ?? [];
          hasContent ||= parts.length > 0;
          abnormalEnd ||=
            response.interrupted === true ||
            (response.finishReason !== undefined && response.finishReason !== FinishReason.STOP);
          if (parts.some((part) => part.functionCall)) budget.onToolCall();
          if (parts.some((part) => part.text || part.functionCall)) {
            emitted = true;
            clearTimeout(timer);
          }
          // Model/safety errors are not transport failures and must not be retried.
          if (response.errorCode || response.errorMessage) {
            reason = 'model_event_error';
            failed = true;
            yield response;
            return;
          }
          if (parts.length > 0) yield response;
          else emptyResponse = response;
        }
        controller.signal.throwIfAborted();
        // An explicit normal empty completion is retryable; an unknown/safety end is not.
        // Keep only this request's metadata private until that decision, never replay prior tools.
        if (!hasContent && !abnormalEnd && emptyResponse?.finishReason === FinishReason.STOP) {
          reason = 'empty_normal_completion';
          failed = true;
          retrying = attempt === 1 && !signal?.aborted && Date.now() < budget.deadlineMs;
        } else {
          if (emptyResponse) yield emptyResponse;
          completed = true;
        }
      } catch (error) {
        failed = true;
        const failure = requestFailure(error);
        httpStatus = failure.httpStatus;
        transportCode = failure.transportCode;
        reason ??= failure.reason;
        retrying =
          attempt === 1 &&
          !emitted &&
          !signal?.aborted &&
          Date.now() < budget.deadlineMs &&
          (reason === 'first_response_timeout' || failure.transient);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.abort();
        reason ??= completed ? null : 'consumer_closed';
        log(completed ? 'completed' : failed ? 'failed' : 'cancelled');
      }
      if (completed) return;
      if (!retrying) throw new Error('model_request_failed');
    }
  }
}

export function createGemini(purpose: ModelPurpose, target: VertexTarget): Gemini {
  assertAdkContentCaptureDisabled();
  if (target.location && target.location !== REGION && !isLocalManualPreview())
    throw new Error(`Gemini must use ${REGION}`);
  return new BoundedGemini(purpose, target);
}

export const PET_AGENT_NAME = 'pet_agent';

export function createPetAgent(input: {
  model: string | BaseLlm;
  instruction: string | InstructionProvider;
  tools: unknown[];
  temperature?: number;
  beforeModelCallback?: BeforeModelCallback;
  afterModelCallback?: AfterModelCallback;
  beforeToolCallback?: BeforeToolCallback;
  afterToolCallback?: AfterToolCallback;
}): LlmAgent {
  const cfg: LlmAgentConfig = {
    name: PET_AGENT_NAME,
    description: '子どもの話を聞く電子ペット',
    model: input.model,
    instruction: input.instruction,
    tools: input.tools as ToolUnion[],
    generateContentConfig: { temperature: input.temperature ?? models.petChat.temperature ?? 0.7 },
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
  };
  if (input.beforeModelCallback) cfg.beforeModelCallback = input.beforeModelCallback;
  if (input.afterModelCallback) cfg.afterModelCallback = input.afterModelCallback;
  if (input.beforeToolCallback) cfg.beforeToolCallback = input.beforeToolCallback;
  if (input.afterToolCallback) cfg.afterToolCallback = input.afterToolCallback;
  return new LlmAgent(cfg);
}

export function createExtractorAgent(input: {
  name: string;
  description: string;
  model: string | BaseLlm;
  instruction: string | InstructionProvider;
  outputSchema: Schema;
  temperature: number;
}): LlmAgent {
  return new LlmAgent({
    name: input.name,
    description: input.description,
    model: input.model,
    instruction: input.instruction,
    outputSchema: input.outputSchema,
    includeContents: 'none',
    generateContentConfig: { temperature: input.temperature },
    disallowTransferToParent: true,
    disallowTransferToPeers: true,
  });
}
