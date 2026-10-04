import { InMemorySessionService, LlmAgent } from '@google/adk';
import { PET_APP_NAME } from '@ijime/agent-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeLiveLlm, until } from '../test/fake-live.js';
import { LiveConnectError, openAdkLive, ResumableGemini } from './live.js';

beforeEach(() => {
  vi.stubEnv('LOCAL_MANUAL_PREVIEW', undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('production Live regional boundary', () => {
  it.each(['gemini-live-2.5-flash-native-audio', 'gemini-3.8-live'])(
    'rejects %s in Tokyo without connecting',
    (model) => {
      vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');
      vi.stubEnv('GEMINI_MODEL_PET_VOICE', model);
      expect(() => new ResumableGemini({ projectId: 'demo-live' })).toThrow(
        'live_tokyo_unavailable',
      );
    },
  );

  it.each(['us-central1', 'eu', 'global'])(
    'rejects explicit %s even outside production mode',
    (location) => {
      vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');
      vi.stubEnv('GEMINI_MODEL_PET_VOICE', 'gemini-3.8-live');
      expect(() => new ResumableGemini({ projectId: 'demo-live', location })).toThrow(
        'tokyo_required',
      );
    },
  );

  it('fails closed for an unreviewed model', () => {
    vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');
    vi.stubEnv('GEMINI_MODEL_PET_VOICE', 'gemini-unknown-001');
    expect(() => new ResumableGemini({ projectId: 'demo-live' })).toThrow('live_model_unverified');
  });
});

describe('local manual Live regional exception', () => {
  beforeEach(() => {
    vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');
    vi.stubEnv('LOCAL_MANUAL_PREVIEW', '1');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080');
    vi.stubEnv('GEMINI_MODEL_PET_VOICE', 'gemini-3.8-live');
  });

  it.each(['development', 'test'])(
    'allows the configured 3.8 model in %s with a local emulator',
    (mode) => {
      vi.stubEnv('NODE_ENV', mode);
      const model = new ResumableGemini({ projectId: 'demo-live', location: 'us-central1' });
      expect(model.model).toBe('gemini-3.8-live');
    },
  );

  it.each(['localhost:8080', '127.0.0.1:65535'])('accepts loopback emulator %s', (host) => {
    vi.stubEnv('FIRESTORE_EMULATOR_HOST', host);
    expect(
      () => new ResumableGemini({ projectId: 'demo-live', location: 'us-central1' }),
    ).not.toThrow();
  });

  it.each([
    ['LOCAL_MANUAL_PREVIEW', undefined],
    ['LOCAL_MANUAL_PREVIEW', '0'],
    ['LOCAL_MANUAL_PREVIEW', 'true'],
    ['NODE_ENV', 'production'],
    ['NODE_ENV', undefined],
    ['NODE_ENV', 'staging'],
    ['FIRESTORE_EMULATOR_HOST', undefined],
    ['FIRESTORE_EMULATOR_HOST', ''],
    ['FIRESTORE_EMULATOR_HOST', 'emulator.example:8080'],
    ['FIRESTORE_EMULATOR_HOST', '192.168.1.2:8080'],
    ['FIRESTORE_EMULATOR_HOST', '0.0.0.0:8080'],
    ['FIRESTORE_EMULATOR_HOST', '[::]:8080'],
    ['FIRESTORE_EMULATOR_HOST', 'localhost.evil.example:8080'],
    ['FIRESTORE_EMULATOR_HOST', 'localhost:8080@evil.example'],
    ['FIRESTORE_EMULATOR_HOST', 'http://localhost:8080'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.1'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:0'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:65536'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.1:8080/path'],
    ['FIRESTORE_EMULATOR_HOST', '127.0.0.999:8080'],
  ])('rejects the exception with %s=%s', (name, value) => {
    vi.stubEnv(name!, value);
    expect(() => new ResumableGemini({ projectId: 'demo-live', location: 'us-central1' })).toThrow(
      'tokyo_required',
    );
  });

  it.each(['us', 'eu'])('allows reviewed 3.8 region %s', (location) => {
    expect(() => new ResumableGemini({ projectId: 'demo-live', location })).not.toThrow();
  });

  it.each(['global', 'us-east1', 'asia-northeast1'])(
    'still rejects unsupported 3.8 region %s',
    (location) => {
      expect(() => new ResumableGemini({ projectId: 'demo-live', location })).toThrow(
        'live_tokyo_unavailable',
      );
    },
  );

  it('still rejects unreviewed models', () => {
    vi.stubEnv('GEMINI_MODEL_PET_VOICE', 'gemini-unknown-001');
    expect(() => new ResumableGemini({ projectId: 'demo-live', location: 'us-central1' })).toThrow(
      'live_model_unverified',
    );
  });

  it('still requires disabled ADK content capture', () => {
    vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'true');
    expect(() => new ResumableGemini({ projectId: 'demo-live', location: 'us-central1' })).toThrow(
      'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS must be "false"',
    );
  });
});

async function setup(model = new FakeLiveLlm()) {
  const sessions = new InMemorySessionService();
  const session = await sessions.createSession({
    appName: PET_APP_NAME,
    userId: 'synthetic-adult',
  });
  return {
    model,
    input: {
      agent: new LlmAgent({ name: 'live_test', model, instruction: 'Synthetic adult test.' }),
      sessionService: sessions,
      childId: 'synthetic-adult',
      sessionId: session.id,
      connected: model.connected,
      connectTimeoutMs: 50,
    },
  };
}

describe('production openAdkLive failure handling', () => {
  it('does not start an already cancelled connection', async () => {
    const t = await setup();
    const connect = vi.spyOn(t.model, 'connect');
    await expect(openAdkLive({ ...t.input, signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
      LiveConnectError,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('bounds a hung connection and returns a content-free error', async () => {
    const t = await setup(new FakeLiveLlm(true));
    const start = Date.now();
    await expect(openAdkLive(t.input)).rejects.toThrow('live connect failed or timed out');
    expect(Date.now() - start).toBeLessThan(3000);
    expect(t.model.connections).toHaveLength(0);
  });

  it('sanitizes connection failures', async () => {
    const t = await setup();
    vi.spyOn(t.model, 'connect').mockRejectedValue(new Error('credential-and-transcript-sentinel'));
    await expect(openAdkLive(t.input)).rejects.toThrow('live connect failed or timed out');
  });

  it('forwards synthetic PCM, closes idempotently, and rejects audio after close', async () => {
    const t = await setup();
    const live = await openAdkLive(t.input);
    const connection = t.model.connections[0]!;
    live.sendAudio(Buffer.alloc(1280));
    await until(() => connection.realtime.length === 1);
    expect(connection.realtime[0]?.mimeType).toBe('audio/pcm;rate=16000');
    await Promise.all([live.close(), live.close()]);
    expect(connection.closed).toBe(true);
    live.sendAudio(Buffer.alloc(1280));
    expect(connection.realtime).toHaveLength(1);
  });

  it('closes an established connection when consent is revoked', async () => {
    const t = await setup();
    const abort = new AbortController();
    const live = await openAdkLive({ ...t.input, signal: abort.signal });
    abort.abort();
    await live.close();
    expect(t.model.connections[0]?.closed).toBe(true);
  });
});
