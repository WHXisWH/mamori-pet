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
import type { Schema } from '@google/genai';
import {
  isLocalManualPreview,
  REGION,
  models,
  resolveModelId,
  type ModelPurpose,
} from '@ijime/config';

import { assertAdkContentCaptureDisabled } from './telemetry.js';

export type VertexTarget = { projectId: string; location?: string };

class BoundedGemini extends Gemini {
  constructor(
    private readonly purpose: ModelPurpose,
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
    yield* super.generateContentAsync(request, stream, signal);
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
