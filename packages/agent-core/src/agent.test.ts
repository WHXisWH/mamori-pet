import { Gemini, LlmAgent, type LlmRequest } from '@google/adk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExtractorAgent, createGemini, createPetAgent, PET_AGENT_NAME } from './agent.js';
import {
  ADK_CONTENT_CAPTURE_ENV,
  assertAdkContentCaptureDisabled,
  disableAdkContentCapture,
  isAdkContentCaptureDisabled,
} from './telemetry.js';
import { createPetTools, type PetToolExecutor } from './tools.js';

const noopExecutor = {} as PetToolExecutor;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('bounded Vertex generation', () => {
  it.each([
    ['petChat', 'GEMINI_MODEL_PET_CHAT', 'gemini-2.5-flash', 0, 1024],
    ['crisisScreen', 'GEMINI_MODEL_CRISIS_SCREEN', 'gemini-2.5-flash', 0, 256],
    ['petChat', 'GEMINI_MODEL_PET_CHAT', 'gemini-3.5-flash', 0, 1024],
    ['crisisScreen', 'GEMINI_MODEL_CRISIS_SCREEN', 'gemini-3.5-flash', 0, 256],
    ['crisisReview', 'GEMINI_MODEL_CRISIS_REVIEW', 'gemini-2.5-pro', 1024, 2048],
  ] as const)(
    'bounds %s without overriding stricter caller transport limits',
    async (purpose, key, modelId, thinkingBudget, maxOutputTokens) => {
      disableAdkContentCapture();
      vi.stubEnv(key, modelId);
      let captured: LlmRequest | undefined;
      const signal = new AbortController().signal;
      const generate = vi
        .spyOn(Gemini.prototype, 'generateContentAsync')
        .mockImplementation(async function* (request) {
          captured = request;
          yield { content: { role: 'model', parts: [{ text: 'ok' }] } };
        });
      const model = createGemini(purpose, { projectId: 'test-project' });
      const request: LlmRequest = {
        contents: [],
        liveConnectConfig: {},
        toolsDict: {},
        config: { temperature: 0, httpOptions: { timeout: 500, headers: { 'x-test': 'yes' } } },
      };
      for await (const response of model.generateContentAsync(request, false, signal)) {
        expect(response.content?.parts?.[0]?.text).toBe('ok');
      }
      expect(captured?.config).toMatchObject({
        temperature: 0,
        maxOutputTokens,
        thinkingConfig: { thinkingBudget, includeThoughts: false },
        httpOptions: { timeout: 500, retryOptions: { attempts: 1 }, headers: { 'x-test': 'yes' } },
      });
      expect(generate).toHaveBeenCalledWith(request, false, signal);
    },
  );

  it('refuses to move content outside Tokyo', () => {
    disableAdkContentCapture();
    vi.stubEnv('GEMINI_MODEL_PET_CHAT', 'gemini-2.5-flash');
    expect(() => createGemini('petChat', { projectId: 'p', location: 'global' })).toThrow(
      'asia-northeast1',
    );
  });

  it('allows a chosen region only for an explicitly local manual preview', () => {
    disableAdkContentCapture();
    vi.stubEnv('GEMINI_MODEL_PET_CHAT', 'gemini-2.5-flash');
    vi.stubEnv('LOCAL_MANUAL_PREVIEW', '1');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:9295');
    const model = createGemini('petChat', { projectId: 'p', location: 'us-central1' });
    expect((model as unknown as { location: string }).location).toBe('us-central1');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => createGemini('petChat', { projectId: 'p', location: 'us-central1' })).toThrow(
      'asia-northeast1',
    );
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', 'remote.test:9295');
    expect(() => createGemini('petChat', { projectId: 'p', location: 'us-central1' })).toThrow(
      'asia-northeast1',
    );
  });
});

describe('createPetAgent', () => {
  it('builds an ADK LlmAgent with all tools and no transfer', () => {
    const tools = createPetTools(
      noopExecutor,
      { childId: 'c', sessionId: 's', gradeBand: 'jhs', characterId: 'nami' },
      () => {},
    );
    const agent = createPetAgent({ model: 'gemini-flash-latest', instruction: 'x', tools });
    expect(agent).toBeInstanceOf(LlmAgent);
    expect(agent.name).toBe(PET_AGENT_NAME);
    expect(agent.tools).toHaveLength(11);
    expect(agent.disallowTransferToParent).toBe(true);
    expect(agent.disallowTransferToPeers).toBe(true);
    expect(agent.generateContentConfig?.temperature).toBe(0.7);
  });

  it('builds a tool-less extractor with an output schema', () => {
    const agent = createExtractorAgent({
      name: 'crisis_review',
      description: 'd',
      model: 'gemini-pro-latest',
      instruction: 'JSON だけを返します。',
      outputSchema: {
        type: 'OBJECT',
        properties: { hit: { type: 'BOOLEAN' } },
        required: ['hit'],
      } as never,
      temperature: 0,
    });
    expect(agent.tools).toHaveLength(0);
    expect(agent.outputSchema).toBeDefined();
    expect(agent.includeContents).toBe('none');
    expect(agent.generateContentConfig?.temperature).toBe(0);
  });
});

describe('telemetry guard', () => {
  it('refuses to create a Vertex model unless content capture is disabled', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(isAdkContentCaptureDisabled(env)).toBe(false);
    expect(() => assertAdkContentCaptureDisabled(env)).toThrow(ADK_CONTENT_CAPTURE_ENV);
    disableAdkContentCapture(env);
    expect(env[ADK_CONTENT_CAPTURE_ENV]).toBe('false');
    expect(() => assertAdkContentCaptureDisabled(env)).not.toThrow();
  });

  it('createGemini targets Vertex AI in Tokyo', () => {
    const prev = process.env[ADK_CONTENT_CAPTURE_ENV];
    const prevModel = process.env['GEMINI_MODEL_PET_CHAT'];
    process.env['GEMINI_MODEL_PET_CHAT'] = 'gemini-test-version';
    delete process.env[ADK_CONTENT_CAPTURE_ENV];
    expect(() => createGemini('petChat', { projectId: 'p' })).toThrow(ADK_CONTENT_CAPTURE_ENV);
    disableAdkContentCapture();
    const g = createGemini('petChat', { projectId: 'p' });
    expect(g.model).toBe('gemini-test-version');
    expect((g as unknown as { vertexai: boolean }).vertexai).toBe(true);
    expect((g as unknown as { location: string }).location).toBe('asia-northeast1');
    if (prev === undefined) delete process.env[ADK_CONTENT_CAPTURE_ENV];
    else process.env[ADK_CONTENT_CAPTURE_ENV] = prev;
    if (prevModel === undefined) delete process.env['GEMINI_MODEL_PET_CHAT'];
    else process.env['GEMINI_MODEL_PET_CHAT'] = prevModel;
  });
});
