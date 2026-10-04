import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  LIMITS,
  observeModel,
  parseArgs,
  preflight,
  probeConnection,
  runBounded,
  safeResult,
  safeDiagnostics,
  supervise,
} from './smoke-live.mjs';

const env = {
  GCP_PROJECT_ID: 'zenn-hackathon-510109',
  GCP_REGION: 'asia-northeast1',
  GEMINI_MODEL_PET_VOICE: 'gemini-live-2.5-flash-native-audio',
};

test('import has no output, credentials or network side effects', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(new URL('./smoke-live.mjs', import.meta.url).href)})`,
    ],
    { encoding: 'utf8', env: {}, timeout: 1000 },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('requires an explicit mode and rejects bypass or unbounded arguments', () => {
  for (const args of [
    [],
    ['--run', '--region', 'us-central1'],
    ['--worker'],
    ['--run', '--attempts', '3'],
    ['--run', '--check'],
  ])
    assert.throws(() => parseArgs(args), /invalid_arguments/);
  assert.deepEqual(parseArgs(['--check']), { mode: '--check' });
  assert.deepEqual(parseArgs(['--run']), { mode: '--run' });
  assert.equal(preflight(undefined, env).category, 'opt_in_required');
});

test('known Live models are blocked in Tokyo, with zero connection attempts', async () => {
  for (const model of ['gemini-live-2.5-flash-native-audio', 'gemini-3.8-live']) {
    const configured = { ...env, GEMINI_MODEL_PET_VOICE: model };
    assert.equal(preflight('--check', configured).category, 'live_tokyo_unavailable');
    const result = await runBounded(configured, () => {
      assert.fail('must not launch or read ADC');
    });
    assert.equal(result.category, 'live_tokyo_unavailable');
    assert.equal(result.status, 'blocked');
    assert.equal(result.connectionAttempts, 0);
  }
});

test('no US, EU, global, inherited location or unreviewed model escape', () => {
  for (const region of ['us-central1', 'eu', 'global', undefined])
    assert.equal(preflight('--run', { ...env, GCP_REGION: region }).category, 'tokyo_required');
  assert.equal(
    preflight('--run', { ...env, GOOGLE_CLOUD_LOCATION: 'global' }).category,
    'tokyo_required',
  );
  assert.equal(
    preflight('--run', { ...env, GEMINI_MODEL_PET_VOICE: 'gemini-future-live' }).category,
    'live_model_unverified',
  );
  assert.equal(preflight('--run', { ...env, GCP_PROJECT_ID: '' }).category, 'project_required');
  assert.equal(
    preflight('--run', { ...env, GEMINI_MODEL_PET_VOICE: '' }).category,
    'model_required',
  );
});

test('isolated diagnostic requires all three explicit flags and a documented model-region pair', () => {
  assert.throws(
    () => parseArgs(['--run', '--diagnostic-region', 'us-central1']),
    /invalid_arguments/,
  );
  const options = parseArgs([
    '--run',
    '--diagnostic-project',
    env.GCP_PROJECT_ID,
    '--diagnostic-region',
    'us-central1',
    '--diagnostic-model',
    env.GEMINI_MODEL_PET_VOICE,
  ]);
  assert.equal(preflight(options.mode, {}, options.diagnostic).category, 'configuration_only');
  assert.equal(preflight(options.mode, env).category, 'live_tokyo_unavailable');
  assert.equal(
    preflight('--run', env, { ...options.diagnostic, region: 'global' }).category,
    'diagnostic_region_unavailable',
  );
  assert.equal(
    preflight('--run', env, { ...options.diagnostic, region: 'asia-northeast1' }).category,
    'diagnostic_region_unavailable',
  );
});

test('diagnostic check does not connect and labels the scope separately from production', () => {
  const result = spawnSync(
    process.execPath,
    [
      new URL('./smoke-live.mjs', import.meta.url).pathname,
      '--check',
      '--diagnostic-project',
      env.GCP_PROJECT_ID,
      '--diagnostic-region',
      'us-central1',
      '--diagnostic-model',
      env.GEMINI_MODEL_PET_VOICE,
    ],
    { env: {}, encoding: 'utf8', timeout: 1000 },
  );
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.category, 'configuration_only');
  assert.equal(report.scope, 'adult-synthetic-diagnostic');
  assert.equal(report.region, 'us-central1');
  assert.equal(report.productionTokyoLive, 'blocked');
  assert.equal(report.connectionAttempts, 0);
});

test('CLI run reports blocked with exit 2 and no sensitive environment values', () => {
  const result = spawnSync(
    process.execPath,
    [new URL('./smoke-live.mjs', import.meta.url).pathname, '--run'],
    { env: { ...env, GOOGLE_API_KEY: 'secret-sentinel' }, encoding: 'utf8', timeout: 1000 },
  );
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).category, 'live_tokyo_unavailable');
  assert.equal(JSON.parse(result.stdout).connectionAttempts, 0);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('secret-sentinel'));
});

test('result reporting discards provider errors, arbitrary keys and malformed counters', () => {
  const result = safeResult({
    category: 'secret-sentinel',
    status: 'pass',
    error: 'private-transcript',
    audio: 'raw-audio',
    connectionAttempts: 300,
    audioBytes: Infinity,
  });
  assert.equal(result.status, 'fail');
  assert.equal(result.category, 'provider_error');
  assert.equal(result.connectionAttempts, 0);
  assert.equal(result.audioBytes, 0);
  assert.ok(!JSON.stringify(result).includes('sentinel'));
  assert.ok(!('error' in result));
  assert.ok(!('audio' in result));
});

test('an IPC pass claim without full audio evidence is a failure', () => {
  assert.equal(safeResult({ category: 'verified' }).category, 'incomplete_response');
});

test('an already cancelled probe cannot make or count a connection', async () => {
  const result = await probeConnection(() => {
    assert.fail('must not connect');
  }, AbortSignal.abort());
  assert.equal(result.category, 'timeout');
  assert.equal(result.connectionAttempts, 0);
});

function fakeConnection(events) {
  const sent = [];
  let closed = 0;
  return {
    sent,
    get closed() {
      return closed;
    },
    async sendContent(content) {
      sent.push(content);
    },
    async sendRealtime(blob) {
      sent.push(blob);
    },
    async sendActivityStart() {},
    async sendActivityEnd() {},
    async *receive() {
      yield* events;
    },
    async close() {
      closed++;
    },
  };
}

const audio = {
  content: {
    role: 'model',
    parts: [
      {
        inlineData: {
          mimeType: 'audio/pcm;rate=24000',
          data: Buffer.alloc(4800, 1).toString('base64'),
        },
      },
    ],
  },
};
const output = { outputTranscription: { text: 'Synthetic reply.' } };
const turn = { turnComplete: true };

test('bounded probe requires two audio turns, output text and loopback input transcription', async () => {
  const connection = fakeConnection([
    audio,
    output,
    turn,
    { inputTranscription: { text: 'Synthetic input.' } },
    audio,
    output,
    turn,
  ]);
  let attempts = 0;
  const result = await probeConnection(async (request) => {
    attempts++;
    assert.equal(request.liveConnectConfig.maxOutputTokens, 128);
    assert.equal(request.liveConnectConfig.httpOptions, undefined);
    return connection;
  }, new AbortController().signal);
  assert.equal(result.status, 'pass');
  assert.equal(result.turns, 2);
  assert.equal(result.audioBytes, 9600);
  assert.equal(result.inputTranscript, true);
  assert.equal(attempts, 1);
  assert.equal(connection.closed, 1);
  assert.equal(connection.sent[1].mimeType, 'audio/pcm;rate=16000');
  assert.equal(Buffer.from(connection.sent[1].data, 'base64').length, 3200);
});

for (const modelId of [env.GEMINI_MODEL_PET_VOICE, 'gemini-3.8-live']) {
  test(`installed ADK and GenAI accept ${modelId} config before the mocked network boundary`, async () => {
    const require = createRequire(new URL('../services/voice-relay/package.json', import.meta.url));
    const { Gemini } = await import(pathToFileURL(require.resolve('@google/adk')).href);
    const model = new Gemini({
      model: modelId,
      vertexai: true,
      project: 'demo-live',
      location: 'us-central1',
    });
    let reached = false;
    model.liveApiClient.live.apiClient.getWebsocketBaseUrl = () => {
      reached = true;
      throw new Error('offline_network_boundary');
    };
    const result = await probeConnection(
      (request) => model.connect(request),
      new AbortController().signal,
    );
    assert.equal(result.category, 'provider_error');
    assert.equal(reached, true);
  });

  test(`installed ADK diagnostic adapter preserves two audio turns for ${modelId}`, async () => {
    const require = createRequire(new URL('../services/voice-relay/package.json', import.meta.url));
    const { Gemini } = await import(pathToFileURL(require.resolve('@google/adk')).href);
    const model = new Gemini({
      model: modelId,
      vertexai: true,
      project: 'demo-live',
      location: 'us-central1',
    });
    let connects = 0;
    let texts = 0;
    let closes = 0;
    model.liveApiClient.live.connect = async ({ config, callbacks }) => {
      connects++;
      assert.deepEqual(config.responseModalities, ['AUDIO']);
      assert.equal(config.httpOptions, undefined);
      callbacks.onmessage({ setupComplete: {} });
      const reply = (loopback) =>
        callbacks.onmessage({
          serverContent: {
            modelTurn: audio.content,
            outputTranscription: output.outputTranscription,
            ...(loopback ? { inputTranscription: { text: 'Synthetic input.' } } : {}),
            generationComplete: true,
            turnComplete: true,
          },
        });
      return {
        sendClientContent() {
          assert.fail('diagnostic must use realtime text');
        },
        sendRealtimeInput(input) {
          if (input.text) {
            texts++;
            reply(false);
          }
          if (input.activityEnd) reply(true);
        },
        close() {
          closes++;
          callbacks.onclose({ code: 1000 });
        },
      };
    };
    const diagnostics = {};
    const result = await probeConnection(
      observeModel(model, diagnostics),
      AbortSignal.timeout(1000),
      diagnostics,
    );
    assert.equal(result.status, 'pass');
    assert.equal(result.diagnostics.events.wire_audio, 2);
    assert.equal(result.diagnostics.events.adk_audio, 2);
    assert.equal(connects, 1);
    assert.equal(texts, 1);
    assert.equal(closes, 1);
  });
}

test('delayed output transcription after turnComplete is accepted without another request', async () => {
  const connection = fakeConnection([
    audio,
    turn,
    output,
    { inputTranscription: { text: 'Synthetic input.' } },
    audio,
    turn,
    output,
  ]);
  const result = await probeConnection(async () => connection, new AbortController().signal);
  assert.equal(result.status, 'pass');
  assert.equal(result.turns, 2);
  assert.equal(result.diagnostics.events.adk_turn_complete, 2);
});

test('delayed loopback input transcription after the second audio turn is required and accepted', async () => {
  const connection = fakeConnection([
    audio,
    output,
    turn,
    audio,
    output,
    turn,
    { inputTranscription: { text: 'Synthetic input.' } },
  ]);
  const result = await probeConnection(async () => connection, new AbortController().signal);
  assert.equal(result.status, 'pass');
  assert.equal(result.inputTranscript, true);
});

test('diagnostic realtime text is preferred without sending duplicate client content', async () => {
  const connection = fakeConnection([]);
  let textCount = 0;
  connection.sendText = async (text) => {
    assert.equal(typeof text, 'string');
    textCount++;
  };
  const result = await probeConnection(async () => connection, new AbortController().signal);
  assert.equal(result.category, 'incomplete_response');
  assert.equal(textCount, 1);
  assert.equal(connection.sent.length, 0);
});

test('an intermediate turnComplete cannot stop an interaction still in progress', async () => {
  const diagnostics = {};
  const connection = fakeConnection([]);
  connection.receive = async function* () {
    diagnostics.interactionStatus = 'IN_PROGRESS';
    yield turn;
    yield audio;
    yield output;
    diagnostics.interactionStatus = 'IDLE';
    yield turn;
    yield { inputTranscription: { text: 'Synthetic input.' } };
    yield audio;
    yield output;
    yield turn;
  };
  const result = await probeConnection(
    async () => connection,
    new AbortController().signal,
    diagnostics,
  );
  assert.equal(result.status, 'pass');
  assert.equal(result.diagnostics.events.adk_turn_complete, 3);
});

test('wire observation preserves callbacks and exports only allowlisted metadata', async () => {
  const diagnostics = {};
  const forwarded = [];
  const sent = [];
  const session = { sendRealtimeInput: (input) => sent.push(input) };
  const model = {
    liveApiClient: {
      live: {
        async connect(params) {
          params.callbacks.onmessage({ setupComplete: { sessionId: 'secret-session' } });
          params.callbacks.onmessage({
            serverContent: {
              modelTurn: {
                parts: [
                  { text: 'private-transcript' },
                  { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'secret-audio' } },
                ],
              },
              turnComplete: true,
              turnCompleteReason: 'NEED_MORE_INPUT',
              interactionStatus: 'IN_PROGRESS',
            },
            usageMetadata: {
              responseTokenCount: 128,
              responseTokensDetails: [{ modality: 'TEXT', tokenCount: 128 }],
            },
          });
          params.callbacks.onerror({ error: { code: 403, message: 'secret-provider-error' } });
          params.callbacks.onclose({ code: 1008, reason: 'private-provider-reason' });
          return session;
        },
      },
    },
    async connect(request) {
      await this.liveApiClient.live.connect({
        config: request.liveConnectConfig,
        callbacks: {
          onmessage: () => forwarded.push('message'),
          onerror: () => forwarded.push('error'),
          onclose: () => forwarded.push('close'),
        },
      });
      return {};
    },
  };
  const connection = await observeModel(model, diagnostics)({ liveConnectConfig: {} });
  await connection.sendText('Synthetic input.');
  assert.deepEqual(sent, [{ text: 'Synthetic input.' }]);
  assert.deepEqual(forwarded, ['message', 'message', 'error', 'close']);
  const safe = safeDiagnostics({
    ...diagnostics,
    leaked: 'secret',
    events: { ...diagnostics.events, 'private-event-key': 1 },
  });
  assert.equal(safe.turnReason, 'NEED_MORE_INPUT');
  assert.equal(safe.interactionStatus, 'IN_PROGRESS');
  assert.equal(safe.errorCode, 403);
  assert.equal(safe.closeCode, 1008);
  assert.equal(safe.events.wire_audio, 1);
  assert.equal(safe.textTokens, 128);
  assert.doesNotMatch(JSON.stringify(safe), /secret|private/);
  assert.equal(safeDiagnostics({ turnReason: 'private', closeCode: 'secret' }).turnReason, null);
  assert.equal(safeDiagnostics({}).responseTokens, null);
  assert.equal(safeDiagnostics({ responseTokens: 0 }).responseTokens, 0);
});

test('connection-only success or absent loopback transcript is not a pass', async () => {
  for (const events of [
    [],
    [audio, output, turn],
    [audio, output, turn, audio, output, turn],
    [audio, output, turn, { inputTranscription: { text: 'Synthetic input.' } }, output, turn],
  ]) {
    const connection = fakeConnection(events);
    const result = await probeConnection(async () => connection, new AbortController().signal);
    assert.equal(result.category, 'incomplete_response');
    assert.equal(connection.closed, 1);
  }
});

test('provider exceptions and response errors never expose raw text', async () => {
  const failed = await probeConnection(async () => {
    throw new Error('secret-sentinel');
  }, new AbortController().signal);
  assert.equal(failed.category, 'provider_error');
  const connection = fakeConnection([{ errorMessage: 'private-transcript' }]);
  const result = await probeConnection(async () => connection, new AbortController().signal);
  assert.equal(result.category, 'provider_error');
  assert.ok(!JSON.stringify([result, failed]).includes('sentinel'));
});

test('aborts a hung connect, closes a late connection, and does not retry', async () => {
  let resolve;
  const abort = new AbortController();
  const pending = probeConnection(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    abort.signal,
  );
  abort.abort();
  assert.equal((await pending).category, 'timeout');
  const connection = fakeConnection([]);
  resolve(connection);
  await new Promise((r) => setImmediate(r));
  assert.equal(connection.closed, 1);
  assert.equal(connection.sent.length, 0);
});

test('aborts an idle stream and closes the connection', async () => {
  const abort = new AbortController();
  const connection = fakeConnection([]);
  connection.receive = async function* () {
    await new Promise(() => {});
    yield turn;
  };
  const pending = probeConnection(async () => connection, abort.signal);
  await new Promise((r) => setImmediate(r));
  abort.abort();
  assert.equal((await pending).category, 'timeout');
  assert.equal(connection.closed, 1);
});

test('hard supervisor kills a hung worker and strips credential keys and logging hooks', async () => {
  const child = new EventEmitter();
  child.kill = (signal) => {
    assert.equal(signal, 'SIGKILL');
    queueMicrotask(() => child.emit('close', null));
  };
  const result = await supervise(
    { ...env, GOOGLE_API_KEY: 'secret', NODE_OPTIONS: '--require spy.js' },
    (_file, _args, options) => {
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      assert.equal(options.env.GOOGLE_API_KEY, undefined);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      assert.equal(options.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS, 'false');
      return child;
    },
    10,
  );
  assert.equal(result.category, 'timeout');
  assert.ok(LIMITS.workerMs <= 45_000);
  assert.ok(LIMITS.connections <= 2);
});

test('abnormal worker exit cannot become a pass', async () => {
  const child = new EventEmitter();
  const result = await supervise(
    env,
    () => {
      queueMicrotask(() => {
        child.emit('message', { category: 'verified' });
        child.emit('close', 1);
      });
      return child;
    },
    100,
  );
  assert.equal(result.category, 'worker_failed');
});

test('worker error followed by a pass message cannot become a pass', async () => {
  const child = new EventEmitter();
  const result = await supervise(
    env,
    () => {
      queueMicrotask(() => {
        child.emit('error', new Error('private-provider-error'));
        child.emit('message', {
          category: 'verified',
          connectionAttempts: 1,
          turns: 2,
          audioBytes: 9600,
          inputAudioBytes: 3200,
          inputTranscript: true,
        });
        child.emit('close', 0);
      });
      return child;
    },
    100,
  );
  assert.equal(result.category, 'worker_failed');
});
