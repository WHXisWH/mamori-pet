import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Firestore } from '@google-cloud/firestore';
import { createNoModelDetector } from '@ijime/crisis-detector';
import { FsKbSource, Kb, lexiconSchema } from '@ijime/kb-loader';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceBackendDeps } from './backend.js';
import { createVoiceRuntime } from './runtime.js';

let overrides: Partial<VoiceBackendDeps>;
beforeAll(async () => {
  const kb = await Kb.load(
    new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
  );
  overrides = {
    kb,
    // Runtime construction must not perform database I/O.
    db: {} as Firestore,
    directory: { lookup: async () => undefined },
    detector: createNoModelDetector(await kb.yaml('lexicon/ja.yaml', lexiconSchema)),
    publish: async () => {},
    countMorae: async () => 0,
    requestRecheck: async () => {},
  };
});

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('LOCAL_MANUAL_PREVIEW', '1');
  vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080');
  vi.stubEnv('GCP_PROJECT_ID', 'demo-live');
  vi.stubEnv('GCP_REGION', 'asia-northeast1');
  vi.stubEnv('LIVE_REGION', 'us-central1');
  vi.stubEnv('VOICE_MODEL_MODE', 'vertex');
  vi.stubEnv('GEMINI_MODEL_PET_VOICE', 'gemini-3.8-live');
  vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');
});
afterEach(() => vi.unstubAllEnvs());

describe('voice runtime Live region selection', () => {
  it.each(['development', 'test'])('uses LIVE_REGION for local manual %s', async (mode) => {
    vi.stubEnv('NODE_ENV', mode);
    const runtime = await createVoiceRuntime(overrides);
    expect(runtime.createModel().model.model).toBe('gemini-3.8-live');
    expect(process.env['GCP_REGION']).toBe('asia-northeast1');
  });

  it.each([
    ['LOCAL_MANUAL_PREVIEW', undefined],
    ['LOCAL_MANUAL_PREVIEW', 'true'],
    ['NODE_ENV', 'production'],
    ['NODE_ENV', undefined],
    ['FIRESTORE_EMULATOR_HOST', undefined],
    ['FIRESTORE_EMULATOR_HOST', 'emulator.example:8080'],
    ['FIRESTORE_EMULATOR_HOST', 'localhost.evil.example:8080'],
  ])('ignores LIVE_REGION with %s=%s', async (name, value) => {
    vi.stubEnv(name!, value);
    const runtime = await createVoiceRuntime(overrides);
    expect(() => runtime.createModel()).toThrow('live_tokyo_unavailable');
  });

  it('keeps the configured GCP region when LIVE_REGION is absent', async () => {
    vi.stubEnv('LIVE_REGION', undefined);
    const runtime = await createVoiceRuntime(overrides);
    expect(() => runtime.createModel()).toThrow('live_tokyo_unavailable');
  });

  it('still rejects an unsupported LIVE_REGION', async () => {
    vi.stubEnv('LIVE_REGION', 'global');
    const runtime = await createVoiceRuntime(overrides);
    expect(() => runtime.createModel()).toThrow('live_tokyo_unavailable');
  });

  it('still rejects non-Tokyo GCP_REGION in production with the flag', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('GCP_REGION', 'us-central1');
    await expect(createVoiceRuntime(overrides)).rejects.toThrow(
      'GCP_REGION must be asia-northeast1 in production',
    );
  });

  it('still requires production safety models with the flag', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CRISIS_MODEL_MODE', 'scripted');
    const withoutDetector = { ...overrides };
    delete withoutDetector.detector;
    await expect(createVoiceRuntime(withoutDetector)).rejects.toThrow(
      'CRISIS_MODEL_MODE must be vertex in production',
    );
  });
});
