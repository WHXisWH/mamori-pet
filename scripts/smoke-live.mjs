import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import availability from '../services/voice-relay/src/live-availability.json' with { type: 'json' };

const FILE = fileURLToPath(import.meta.url);
export const REGION = 'asia-northeast1';
export const LIMITS = Object.freeze({
  connections: 1,
  workerMs: 45_000,
  sessionMs: 40_000,
  outputBytes: 1_000_000,
});
const BLOCKED = new Set([
  'opt_in_required',
  'configuration_only',
  'project_required',
  'model_required',
  'tokyo_required',
  'live_model_unverified',
  'live_tokyo_unavailable',
  'build_required',
  'diagnostic_target_required',
  'diagnostic_region_unavailable',
]);
const FAILED = new Set([
  'invalid_arguments',
  'timeout',
  'provider_error',
  'worker_failed',
  'incomplete_response',
  'output_limit',
]);
const count = (value, limit) =>
  Number.isSafeInteger(value) && value >= 0 && value <= limit ? value : 0;
const tokenCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : null;
const EVENT_KINDS = [
  'setup',
  'wire_audio',
  'wire_text',
  'wire_input_transcript',
  'wire_output_transcript',
  'generation_complete',
  'wire_turn_complete',
  'interrupted',
  'usage',
  'go_away',
  'transport_error',
  'transport_close',
  'adk_audio',
  'adk_text',
  'adk_input_transcript',
  'adk_output_transcript',
  'adk_turn_complete',
  'stream_end',
];
const TURN_REASONS = new Set([
  'TURN_COMPLETE_REASON_UNSPECIFIED',
  'MALFORMED_FUNCTION_CALL',
  'RESPONSE_REJECTED',
  'NEED_MORE_INPUT',
  'PROHIBITED_INPUT_CONTENT',
  'BLOCKLIST',
  'GENERATED_CONTENT_SAFETY',
  'GENERATED_AUDIO_SAFETY',
]);
const INTERACTIONS = new Set([
  'INTERACTION_STATUS_UNSPECIFIED',
  'IN_PROGRESS',
  'REQUIRES_ACTION',
  'IDLE',
]);
const ERROR_CODES = new Set([
  400, 401, 403, 404, 429, 500, 503, 1000, 1001, 1002, 1003, 1006, 1007, 1008, 1009, 1011, 1012,
  1013, 1015,
]);
const bump = (diagnostics, kind) => {
  diagnostics.events ??= {};
  diagnostics.events[kind] = Math.min(4096, (diagnostics.events[kind] ?? 0) + 1);
};

export function safeDiagnostics(value = {}) {
  return {
    events: Object.fromEntries(
      EVENT_KINDS.filter((kind) => count(value.events?.[kind], 4096)).map((kind) => [
        kind,
        value.events[kind],
      ]),
    ),
    turnReason: TURN_REASONS.has(value.turnReason) ? value.turnReason : null,
    interactionStatus: INTERACTIONS.has(value.interactionStatus) ? value.interactionStatus : null,
    closeCode: ERROR_CODES.has(value.closeCode) ? value.closeCode : null,
    errorCode: ERROR_CODES.has(value.errorCode) ? value.errorCode : null,
    responseTokens: tokenCount(value.responseTokens),
    thoughtTokens: tokenCount(value.thoughtTokens),
    audioTokens: tokenCount(value.audioTokens),
    textTokens: tokenCount(value.textTokens),
  };
}

// ADK omits wire terminal reasons. Retain only these fixed metadata fields, never content/errors.
export function observeModel(model, diagnostics) {
  const live = model.liveApiClient.live;
  const connect = live.connect.bind(live);
  let session;
  live.connect = async (params) => {
    session = await connect({
      ...params,
      callbacks: {
        ...params.callbacks,
        onmessage: (message) => {
          if (message.setupComplete) bump(diagnostics, 'setup');
          if (message.goAway) bump(diagnostics, 'go_away');
          const content = message.serverContent;
          if (content) {
            for (const part of content.modelTurn?.parts ?? []) {
              if (part.inlineData?.mimeType?.startsWith('audio/')) bump(diagnostics, 'wire_audio');
              if (part.text) bump(diagnostics, 'wire_text');
            }
            if (content.inputTranscription) bump(diagnostics, 'wire_input_transcript');
            if (content.outputTranscription) bump(diagnostics, 'wire_output_transcript');
            if (content.generationComplete) bump(diagnostics, 'generation_complete');
            if (content.interrupted) bump(diagnostics, 'interrupted');
            if (content.turnComplete) {
              bump(diagnostics, 'wire_turn_complete');
              diagnostics.turnReason = TURN_REASONS.has(content.turnCompleteReason)
                ? content.turnCompleteReason
                : null;
              diagnostics.interactionStatus = INTERACTIONS.has(content.interactionStatus)
                ? content.interactionStatus
                : null;
            }
          }
          if (message.usageMetadata) {
            bump(diagnostics, 'usage');
            const usage = message.usageMetadata;
            diagnostics.responseTokens = tokenCount(usage.responseTokenCount);
            diagnostics.thoughtTokens = tokenCount(usage.thoughtsTokenCount);
            for (const entry of usage.responseTokensDetails ?? []) {
              if (entry.modality === 'AUDIO')
                diagnostics.audioTokens = tokenCount(entry.tokenCount);
              if (entry.modality === 'TEXT') diagnostics.textTokens = tokenCount(entry.tokenCount);
            }
          }
          params.callbacks.onmessage(message);
        },
        onerror: (event) => {
          bump(diagnostics, 'transport_error');
          const code = event?.error?.code ?? event?.error?.status ?? event?.code;
          diagnostics.errorCode = ERROR_CODES.has(code) ? code : null;
          params.callbacks.onerror?.(event);
        },
        onclose: (event) => {
          bump(diagnostics, 'transport_close');
          diagnostics.closeCode = ERROR_CODES.has(event?.code) ? event.code : null;
          params.callbacks.onclose?.(event);
        },
      },
    });
    return session;
  };
  return async (request) => {
    const connection = await model.connect(request);
    // Diagnostic only: use the SDK's realtime text path, not ADK 2.5's history path.
    connection.sendText = (text) => session.sendRealtimeInput({ text });
    return connection;
  };
}

export function safeResult(value = {}) {
  let category =
    value.category === 'verified' || BLOCKED.has(value.category) || FAILED.has(value.category)
      ? value.category
      : 'provider_error';
  if (
    category === 'verified' &&
    (value.connectionAttempts !== 1 ||
      value.turns !== 2 ||
      value.inputTranscript !== true ||
      count(value.audioBytes, LIMITS.outputBytes) === 0 ||
      count(value.inputAudioBytes, 96_000) === 0)
  )
    category = 'incomplete_response';
  return {
    status: category === 'verified' ? 'pass' : BLOCKED.has(category) ? 'blocked' : 'fail',
    category,
    connectionAttempts: count(value.connectionAttempts, LIMITS.connections),
    audioBytes: count(value.audioBytes, LIMITS.outputBytes),
    turns: count(value.turns, 2),
    inputTranscript: value.inputTranscript === true,
    inputAudioBytes: count(value.inputAudioBytes, 96_000),
    connectionMs: count(value.connectionMs, LIMITS.workerMs),
    firstAudioMs: count(value.firstAudioMs, LIMITS.workerMs),
    durationMs: count(value.durationMs, LIMITS.workerMs),
    diagnostics: safeDiagnostics(value.diagnostics),
  };
}

export function parseArgs(args) {
  if (!['--check', '--run', '--help'].includes(args[0])) throw new Error('invalid_arguments');
  const options = { mode: args[0] };
  if (args.length === 1) return options;
  const diagnostic = {};
  for (let i = 1; i < args.length; i += 2) {
    const key = {
      '--diagnostic-project': 'project',
      '--diagnostic-region': 'region',
      '--diagnostic-model': 'model',
    }[args[i]];
    if (!key || diagnostic[key] || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('invalid_arguments');
    diagnostic[key] = args[i + 1];
  }
  if (options.mode === '--help' || !diagnostic.project || !diagnostic.region || !diagnostic.model)
    throw new Error('invalid_arguments');
  return { ...options, diagnostic };
}

export function preflight(mode, env, diagnostic) {
  if (!['--check', '--run'].includes(mode)) return safeResult({ category: 'opt_in_required' });
  if (diagnostic) {
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(diagnostic.project ?? ''))
      return safeResult({ category: 'diagnostic_target_required' });
    const reviewed = availability.models.find((entry) => entry.id === diagnostic.model);
    if (!reviewed) return safeResult({ category: 'live_model_unverified' });
    if (!reviewed.regions.includes(diagnostic.region))
      return safeResult({ category: 'diagnostic_region_unavailable' });
    return safeResult({ category: 'configuration_only' });
  }
  if (
    env.GCP_REGION !== REGION ||
    (env.GOOGLE_CLOUD_LOCATION && env.GOOGLE_CLOUD_LOCATION !== REGION)
  )
    return safeResult({ category: 'tokyo_required' });
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(env.GCP_PROJECT_ID ?? ''))
    return safeResult({ category: 'project_required' });
  const model = env.GEMINI_MODEL_PET_VOICE;
  if (!model) return safeResult({ category: 'model_required' });
  const reviewed = availability.models.find((entry) => entry.id === model);
  if (!reviewed) return safeResult({ category: 'live_model_unverified' });
  if (!reviewed.regions.includes(REGION)) return safeResult({ category: 'live_tokyo_unavailable' });
  return safeResult({ category: 'configuration_only' });
}

// A future reviewed Tokyo model uses the production connection adapter, not a Developer API key.
// Both generated speech and its PCM loopback stay in memory. No microphone or external tools.
export async function probeConnection(connect, signal, diagnostics = {}) {
  const start = Date.now();
  let connectionMs = 0;
  let firstAudioMs = 0;
  let inputAudioBytes = 0;
  let connection;
  let connectionAttempts = 0;
  let expired = false;
  let audioBytes = 0;
  let turns = 0;
  let inputTranscript = false;
  let outputTranscript = false;
  let turnAudioBytes = 0;
  let turnEnded = false;
  const chunks = [];
  let rejectAbort;
  const cancelled = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    expired = true;
    rejectAbort(new Error('timeout'));
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const work = async () => {
    if (expired) throw new Error('timeout');
    connectionAttempts++;
    connection = await connect({
      contents: [],
      config: { systemInstruction: 'Adult synthetic technical test. Reply briefly in Japanese.' },
      liveConnectConfig: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        maxOutputTokens: 128,
        abortSignal: signal,
      },
    });
    connectionMs = Date.now() - start;
    if (expired) {
      await connection.close();
      throw new Error('timeout');
    }
    const text = 'Say only: \u3053\u3093\u306b\u3061\u306f\u3002';
    if (connection.sendText) await connection.sendText(text);
    else await connection.sendContent({ role: 'user', parts: [{ text }] });
    for await (const event of connection.receive()) {
      if (expired) throw new Error('timeout');
      if (event.errorCode || event.errorMessage) throw new Error('provider_error');
      if (event.inputTranscription) bump(diagnostics, 'adk_input_transcript');
      if (event.outputTranscription) bump(diagnostics, 'adk_output_transcript');
      if (turns === 1 && event.inputTranscription?.text) inputTranscript = true;
      if (event.outputTranscription?.text) outputTranscript = true;
      for (const part of event.content?.parts ?? []) {
        if (part.text) bump(diagnostics, 'adk_text');
        if (!part.inlineData?.mimeType?.startsWith('audio/pcm') || !part.inlineData.data) continue;
        bump(diagnostics, 'adk_audio');
        if (part.inlineData.data.length > LIMITS.outputBytes * 2) throw new Error('output_limit');
        const pcm = Buffer.from(part.inlineData.data, 'base64');
        if (!audioBytes) firstAudioMs = Date.now() - start;
        audioBytes += pcm.length;
        turnAudioBytes += pcm.length;
        if (audioBytes > LIMITS.outputBytes) throw new Error('output_limit');
        if (turns === 0) chunks.push(pcm);
      }
      if (event.turnComplete) {
        bump(diagnostics, 'adk_turn_complete');
        // IN_PROGRESS is not the terminal end of an interaction; more output can follow.
        if (diagnostics.interactionStatus === 'IN_PROGRESS') continue;
        turnEnded = true;
        if (!turnAudioBytes) throw new Error('incomplete_response');
      }
      if (!turnEnded || !turnAudioBytes || !outputTranscript) continue;
      // Input transcription is independently ordered, including after the second turn.
      if (turns === 1 && !inputTranscript) continue;
      turns++;
      if (turns === 2) break;
      // The documented 24 kHz output is converted to 16 kHz input; cap loopback at 3 seconds.
      const source = Buffer.concat(chunks).subarray(0, 24_000 * 2 * 3);
      chunks.length = 0;
      const samples = Math.floor(((source.length / 2) * 2) / 3);
      const pcm = Buffer.alloc(samples * 2);
      for (let i = 0; i < samples; i++)
        pcm.writeInt16LE(source.readInt16LE(Math.floor(i * 1.5) * 2), i * 2);
      inputAudioBytes = pcm.length;
      await connection.sendActivityStart();
      for (let offset = 0; offset < pcm.length; offset += 3200) {
        await connection.sendRealtime({
          mimeType: 'audio/pcm;rate=16000',
          data: pcm.subarray(offset, offset + 3200).toString('base64'),
        });
        await sleep(100, undefined, { signal });
      }
      await connection.sendActivityEnd();
      outputTranscript = false;
      turnAudioBytes = 0;
      turnEnded = false;
    }
    if (turns !== 2) bump(diagnostics, 'stream_end');
    if (turns !== 2 || !inputTranscript || !outputTranscript)
      throw new Error('incomplete_response');
    return safeResult({
      category: 'verified',
      connectionAttempts,
      audioBytes,
      turns,
      inputTranscript,
      inputAudioBytes,
      connectionMs,
      firstAudioMs,
      durationMs: Date.now() - start,
      diagnostics,
    });
  };
  try {
    return await Promise.race([work(), cancelled]);
  } catch (error) {
    return safeResult({
      category: expired ? 'timeout' : FAILED.has(error?.message) ? error.message : 'provider_error',
      connectionAttempts,
      audioBytes,
      turns,
      inputTranscript,
      inputAudioBytes,
      connectionMs,
      firstAudioMs,
      durationMs: Date.now() - start,
      diagnostics,
    });
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (connection) {
      let timer;
      await Promise.race([
        Promise.resolve()
          .then(() => connection.close())
          .catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      clearTimeout(timer);
    }
  }
}

export function runBounded(env, launch = fork, timeoutMs = LIMITS.workerMs, diagnostic) {
  const gate = preflight('--run', env, diagnostic);
  if (gate.category !== 'configuration_only') return Promise.resolve(gate);
  return supervise(env, launch, timeoutMs, diagnostic);
}

export function supervise(env, launch, timeoutMs, diagnostic) {
  return new Promise((resolve) => {
    const workerEnv = { ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false', OTEL_SDK_DISABLED: 'true' };
    for (const key of [
      'HOME',
      'PATH',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'CLOUDSDK_CONFIG',
      'GCP_PROJECT_ID',
      'GEMINI_MODEL_PET_VOICE',
    ])
      if (env[key]) workerEnv[key] = env[key];
    workerEnv.GCP_REGION = REGION;
    workerEnv.GOOGLE_CLOUD_LOCATION = REGION;
    let child;
    try {
      const args = diagnostic
        ? [
            '--worker',
            '--diagnostic-project',
            diagnostic.project,
            '--diagnostic-region',
            diagnostic.region,
            '--diagnostic-model',
            diagnostic.model,
          ]
        : ['--worker'];
      child = launch(FILE, args, {
        env: workerEnv,
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
    } catch {
      resolve(safeResult({ category: 'worker_failed' }));
      return;
    }
    let result;
    let failed = false;
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGKILL');
      },
      Math.max(1, Math.min(timeoutMs, LIMITS.workerMs)),
    );
    child.on('message', (message) => {
      result = safeResult(message);
    });
    child.on('error', () => {
      failed = true;
      result = safeResult({ category: 'worker_failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(
        timedOut
          ? safeResult({ category: 'timeout', connectionAttempts: 1 })
          : !failed && code === 0 && result
            ? result
            : safeResult({ category: 'worker_failed' }),
      );
    });
  });
}

async function worker() {
  const { diagnostic } = parseArgs(['--run', ...process.argv.slice(3)]);
  const gate = preflight('--run', process.env, diagnostic);
  if (gate.category !== 'configuration_only') return gate;
  if (diagnostic) {
    const require = createRequire(new URL('../services/voice-relay/package.json', import.meta.url));
    const { Gemini } = await import(pathToFileURL(require.resolve('@google/adk')).href);
    const model = new Gemini({
      model: diagnostic.model,
      vertexai: true,
      project: diagnostic.project,
      location: diagnostic.region,
    });
    const diagnostics = {};
    return probeConnection(
      observeModel(model, diagnostics),
      AbortSignal.timeout(LIMITS.sessionMs),
      diagnostics,
    );
  }
  let adapter;
  try {
    adapter = await import('../services/voice-relay/dist/live.js');
  } catch {
    return safeResult({ category: 'build_required' });
  }
  const model = new adapter.ResumableGemini({
    projectId: process.env.GCP_PROJECT_ID,
    location: REGION,
  });
  return probeConnection(
    (request) => model.connect(request),
    AbortSignal.timeout(LIMITS.sessionMs),
  );
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let options;
  let result;
  try {
    options = parseArgs(args);
  } catch {
    result = safeResult({ category: 'invalid_arguments' });
  }
  if (options?.mode === '--help') {
    process.stdout.write(
      'Usage: node scripts/smoke-live.mjs --check|--run [--diagnostic-project PROJECT --diagnostic-region REGION --diagnostic-model MODEL]\nDefault: production Tokyo policy. Diagnostic flags: isolated adult synthetic-only ADC validation; never child product acceptance.\n',
    );
    return 0;
  }
  result ??=
    options.mode === '--run'
      ? await runBounded(env, fork, LIMITS.workerMs, options.diagnostic)
      : preflight(options.mode, env, options.diagnostic);
  const diagnostic = options?.diagnostic;
  const region = diagnostic
    ? availability.models.some((entry) => entry.regions.includes(diagnostic.region))
      ? diagnostic.region
      : null
    : REGION;
  process.stdout.write(
    `${JSON.stringify({ ...result, scope: diagnostic ? 'adult-synthetic-diagnostic' : 'production', region, model: availability.models.some((entry) => entry.id === (diagnostic?.model ?? env.GEMINI_MODEL_PET_VOICE)) ? (diagnostic?.model ?? env.GEMINI_MODEL_PET_VOICE) : null, productionTokyoLive: 'blocked', checkedOn: availability.checkedOn, limits: LIMITS })}\n`,
  );
  return result.status === 'pass' ? 0 : result.status === 'blocked' ? 2 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] === '--worker' && process.send) {
    worker()
      .catch(() => safeResult({ category: 'provider_error' }))
      .then((result) => {
        process.send(safeResult(result), () => process.exit(0));
      });
  } else {
    main()
      .then((code) => {
        process.exitCode = code;
      })
      .catch(() => {
        process.stdout.write(`${JSON.stringify(safeResult({ category: 'worker_failed' }))}\n`);
        process.exitCode = 1;
      });
  }
}
