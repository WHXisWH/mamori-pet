import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { SYNTHETIC_PNG } from './smoke-google.mjs';

const FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(FILE), '..');
const requireCore = createRequire(join(ROOT, 'packages/agent-core/package.json'));
export const CASES = Object.freeze([
  'chat',
  'tool',
  'context',
  'screen-normal',
  'screen-danger',
  'review-family',
  'review-fiction',
  'signal-self',
  'signal-fiction',
  'image',
  'embedding',
  'live',
  'adk-live',
]);
const BLOCKED = new Set([
  'unauthenticated',
  'permission_denied',
  'quota_exhausted',
  'model_unavailable',
  'live_model_required',
  'call_budget',
  'previous_access_failure',
  'total_timeout',
]);
const CATEGORIES = new Set([
  ...BLOCKED,
  'verified',
  'provider_error',
  'timeout',
  'schema',
  'expectation_failed',
  'worker_failed',
  'ffmpeg_required',
  'connection_closed',
  'audio_not_observed',
]);
const ensure = (value, category = 'expectation_failed') => {
  if (!value) throw Object.assign(new Error(category), { category });
};
const validModel = (value) =>
  typeof value === 'string' &&
  /^gemini-\d+(?:\.\d+)?-[a-z0-9.-]{1,70}$/.test(value) &&
  !/(latest|auto|alias)/.test(value);

export function parseArgs(args) {
  const options = { cases: [...CASES] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--run') options.run = true;
    else if (['--model', '--live-model', '--case'].includes(arg)) {
      const value = args[++i];
      ensure(value, 'invalid_arguments');
      if (arg === '--case') options.cases = [...new Set(value.split(','))];
      else options[arg === '--model' ? 'model' : 'liveModel'] = value;
    } else ensure(false, 'invalid_arguments');
  }
  ensure(options.run && validModel(options.model), 'invalid_arguments');
  ensure(!options.liveModel || validModel(options.liveModel), 'invalid_arguments');
  ensure(
    options.cases.length && options.cases.every((id) => CASES.includes(id)),
    'invalid_arguments',
  );
  return options;
}

export class Budget {
  used = 0;
  constructor(limit = 16) {
    this.limit = limit;
  }
  take() {
    ensure(this.used < this.limit, 'call_budget');
    this.used++;
  }
}

export function classify(error) {
  if (CATEGORIES.has(error?.category)) return error.category;
  const status = error?.status ?? error?.response?.status;
  return (
    {
      401: 'unauthenticated',
      403: 'permission_denied',
      404: 'model_unavailable',
      429: 'quota_exhausted',
    }[status] ??
    (['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'provider_error')
  );
}

// SDK output stays inside a worker; only this metadata allowlist crosses IPC.
export function safeRow(value) {
  const category = CATEGORIES.has(value?.category) ? value.category : 'worker_failed';
  const out = {
    case: CASES.includes(value?.case) ? value.case : 'worker',
    status: category === 'verified' ? 'pass' : BLOCKED.has(category) ? 'blocked' : 'fail',
    category,
  };
  for (const key of [
    'durationMs',
    'calls',
    'tokens',
    'audioBytes',
    'inputAudioBytes',
    'firstChunkMs',
    'streamChunks',
    'toolCalls',
    'inputTranscriptChars',
    'outputTranscriptChars',
    'httpStatus',
    'modelMs',
  ]) {
    if (Number.isFinite(value?.[key]) && value[key] >= 0) out[key] = Math.round(value[key]);
  }
  return out;
}

export function verifyReceipt(call, response, executions, output, receipt) {
  return call && response && executions === 1 && output.includes(receipt);
}

export function diagnosticExitCode(rows, workerCode) {
  return workerCode === 0 && rows.length > 0 && rows.every((row) => row.status === 'pass') ? 0 : 1;
}

export async function connectWithinSignal(connect, signal) {
  signal.throwIfAborted();
  let onAbort;
  const connection = connect().then((session) => {
    if (signal.aborted) {
      void Promise.resolve()
        .then(() => session.close())
        .catch(() => {});
      signal.throwIfAborted();
    }
    return session;
  });
  try {
    return await Promise.race([
      connection,
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function verifyVectors(vectors) {
  if (!Array.isArray(vectors) || vectors.length !== 3 || !vectors[0]?.length) return false;
  const norm = (v) => Math.sqrt(v.reduce((n, x) => n + x * x, 0));
  if (
    !vectors.every(
      (v) =>
        Array.isArray(v) &&
        v.length === vectors[0].length &&
        v.every(Number.isFinite) &&
        norm(v) > 0,
    )
  )
    return false;
  const similarity = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0) / norm(a) / norm(b);
  return similarity(vectors[0], vectors[1]) > similarity(vectors[0], vectors[2]);
}

const localImport = (path) => import(pathToFileURL(join(ROOT, path)).href);
const dependency = (name) => import(pathToFileURL(requireCore.resolve(name)).href);

async function chatProbe(id, ctx) {
  const { adk, z, model, metrics } = ctx;
  const receipt = randomBytes(12).toString('hex');
  let executions = 0;
  const tool = new adk.FunctionTool({
    name: 'read_test_receipt',
    description: 'Read the current synthetic diagnostic receipt.',
    parameters: z.object({}).strict(),
    execute: () => {
      ensure(++executions === 1);
      return { receipt };
    },
  });
  const agent = new adk.LlmAgent({
    name: 'adult_developer_diagnostic',
    model,
    instruction:
      'You assist an adult software developer with a synthetic connectivity test. Follow the exact requested output format. Use available tools when needed. Answer briefly.',
    tools: id === 'tool' ? [tool] : [],
    generateContentConfig: { temperature: 0 },
  });
  const runner = new adk.InMemoryRunner({ agent, appName: 'adult_developer_diagnostic' });
  const session = await runner.sessionService.createSession({
    appName: 'adult_developer_diagnostic',
    userId: 'synthetic',
  });
  let call = false;
  let response = false;
  const turn = async (text) => {
    let output = '';
    const start = Date.now();
    for await (const event of runner.runAsync({
      userId: 'synthetic',
      sessionId: session.id,
      newMessage: { role: 'user', parts: [{ text }] },
      runConfig: { maxLlmCalls: id === 'tool' ? 2 : 1, streamingMode: adk.StreamingMode.SSE },
      abortSignal: AbortSignal.timeout(35_000),
    })) {
      ensure(!event.errorCode && !event.errorMessage, 'provider_error');
      for (const part of event.content?.parts ?? []) {
        if (part.functionCall?.name === tool.name) call = true;
        if (part.functionResponse?.name === tool.name) response = true;
        if (event.partial && part.text && !part.thought) {
          metrics.streamChunks = (metrics.streamChunks ?? 0) + 1;
          metrics.firstChunkMs ??= Date.now() - start;
        }
      }
      if (
        event.content?.role === 'model' &&
        !event.partial &&
        !event.content.parts?.some((part) => part.functionCall)
      ) {
        output =
          event.content.parts
            .filter((part) => !part.thought)
            .map((part) => part.text ?? '')
            .join('') || output;
      }
    }
    return output;
  };
  try {
    if (id === 'context') {
      await turn(`Remember this temporary test code: ${receipt}. Reply OK.`);
      ensure(
        (
          await turn('Return only the temporary test code I provided in my previous message.')
        ).trim() === receipt,
      );
    } else {
      const output = await turn(
        id === 'tool'
          ? 'What is the current diagnostic receipt? Include its exact value.'
          : `Say hello in Japanese, followed by this exact code: ${receipt}.`,
      );
      if (id === 'tool') {
        ensure(verifyReceipt(call, response, executions, output, receipt));
        metrics.toolCalls = executions;
      } else
        ensure(
          output.includes(receipt) &&
            /[\u3040-\u30ff\u4e00-\u9fff]/.test(output) &&
            metrics.streamChunks > 0,
        );
    }
  } finally {
    await runner.sessionService.deleteSession({
      appName: 'adult_developer_diagnostic',
      userId: 'synthetic',
      sessionId: session.id,
    });
  }
}

const NORMAL =
  '\u304d\u3087\u3046\u306f\u53cb\u3060\u3061\u3068\u516c\u5712\u3067\u904a\u3093\u3060';
const DANGER =
  '\u4eca\u304a\u7236\u3055\u3093\u306b\u6bb4\u3089\u308c\u3066\u3044\u3066\u3001\u5bb6\u306b\u3044\u308b\u306e\u304c\u6016\u3044';
const SELF =
  '\u6bce\u65e5\u3001\u540c\u7d1a\u751f\u306b\u305f\u305f\u304b\u308c\u3066\u3044\u308b\u3002\u5b66\u6821\u306b\u884c\u304d\u305f\u304f\u306a\u3044\u3002';
const FICTION =
  '\u3053\u308c\u306f\u4f5c\u308a\u8a71\u3067\u3059\u3002\u7269\u8a9e\u306e\u4e3b\u4eba\u516c\u304c\u305f\u305f\u304b\u308c\u307e\u3057\u305f\u3002\u81ea\u5206\u306b\u306f\u8d77\u304d\u3066\u3044\u307e\u305b\u3093\u3002';

async function structuredProbe(id, ctx) {
  const { core, loader, kb, model } = ctx;
  const name = id.startsWith('screen-')
    ? 'crisis_screen'
    : id.startsWith('review-')
      ? 'crisis_review'
      : id.startsWith('signal-')
        ? 'signal_extract'
        : 'artwork_feature';
  const schema = JSON.parse(await kb.text(`schemas/${name}.json`));
  let prompt = (await kb.text(`prompts/${name}.md`)).replaceAll('{gradeBand}', 'high');
  const text = id.endsWith('fiction')
    ? FICTION
    : id === 'signal-self'
      ? SELF
      : ['screen-danger', 'review-family'].includes(id)
        ? DANGER
        : NORMAL;
  let input = JSON.stringify({ latest: text, priorTurns: [] });
  let defs = [];
  if (name === 'signal_extract') {
    for (const path of kb.paths('signals/').filter((path) => path.endsWith('.yaml'))) {
      const def = await kb.yaml(path, loader.signalDefinitionSchema);
      if (def.domain === 'a' && def.method === 'model') defs.push(def);
    }
    prompt = prompt.replace(
      '{signalDefinitions}',
      JSON.stringify(
        defs.map((def) => ({
          signalDefId: def.signal_id,
          description: def.description,
          examples: def.examples_ja,
        })),
      ),
    );
    input = JSON.stringify({ current: { role: 'child', turnIndex: 0, text }, prior: [] });
  }
  if (id === 'image') {
    prompt = prompt
      .replace('{type}', 'story')
      .replace('{narrative}', 'Synthetic blank image. No people or injuries.');
    input = [
      { text: 'Synthetic blank image. No people or injuries.' },
      { inlineData: { mimeType: 'image/png', data: SYNTHETIC_PNG } },
    ];
  }
  const agent = core.createExtractorAgent({
    name: `diagnostic_${name}`,
    description: 'Adult-only offline evaluation of synthetic fixtures',
    model,
    instruction: () => prompt,
    outputSchema: core.toGenaiSchema(schema),
    temperature: 0,
  });
  const result = await core.runStructured(agent, input, {
    schema,
    maxAttempts: 1,
    timeoutMs: 30_000,
  });
  if (!result.ok)
    ensure(false, ctx.lastError ?? (result.reason === 'timeout' ? 'timeout' : 'schema'));
  const value = result.value;
  ensure(!Object.hasOwn(value, 'riskLevel'));
  if (id.startsWith('screen-')) ensure(value.suspect === (id === 'screen-danger'));
  if (id === 'review-family')
    ensure(
      value.hit &&
        value.category === 'family_harm' &&
        value.evidenceSpan?.length &&
        DANGER.includes(value.evidenceSpan),
    );
  if (id === 'review-fiction') ensure(value.hit === false && value.category === 'none');
  if (id.startsWith('signal-')) {
    ensure(
      value.signals.every((item) =>
        defs.some((def) => def.signal_id === item.signalDefId && (!item.explicit || def.explicit)),
      ),
    );
    if (id === 'signal-fiction')
      ensure(value.signals.every((item) => !item.explicit) && !value.schoolAvoidance);
    else
      ensure(
        value.schoolAvoidance &&
          value.signals.some(
            (item) =>
              item.explicit &&
              item.contextKind === 'self_report' &&
              item.evidence?.some(
                (e) =>
                  e.source === 'current' &&
                  e.turnIndex === 0 &&
                  e.quote?.length &&
                  SELF.includes(e.quote),
              ),
          ),
      );
  }
  if (id === 'image')
    ensure(value.selfPresent === false && value.othersCount === 0 && value.explicitHarm === false);
}

function resample(audio) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        's16le',
        '-ar',
        '24000',
        '-ac',
        '1',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        '16000',
        '-ac',
        '1',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const chunks = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error(), { category: 'ffmpeg_required' }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(Object.assign(new Error(), { category: 'ffmpeg_required' }));
    });
    child.stdin.end(audio);
  });
}

async function liveProbe(ctx, options) {
  ensure(options.liveModel, 'live_model_required');
  ctx.budget.take();
  const queue = [];
  let wake;
  let session;
  const controller = new AbortController();
  const started = Date.now();
  const enqueue = (message) => {
    queue.push(message);
    wake?.();
  };
  const next = async () => {
    while (!queue.length) {
      const left = 45_000 - (Date.now() - started);
      ensure(left > 0, 'timeout');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 1000));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
    const message = queue.shift();
    ensure(!message.closed, message.category ?? 'connection_closed');
    return message;
  };
  const timer = setTimeout(() => {
    controller.abort();
    session?.close();
  }, 45_000);
  try {
    session = await connectWithinSignal(
      () =>
        ctx.client.live.connect({
          model: options.liveModel,
          callbacks: {
            onmessage: enqueue,
            onerror: () => enqueue({ closed: true, category: 'provider_error' }),
            onclose: (event) =>
              enqueue({
                closed: true,
                category: /quota|resource.exhausted/i.test(event.reason ?? '')
                  ? 'quota_exhausted'
                  : /not.found|not.supported|not.available/i.test(event.reason ?? '')
                    ? 'model_unavailable'
                    : 'connection_closed',
              }),
          },
          config: {
            abortSignal: controller.signal,
            responseModalities: ['AUDIO'],
            maxOutputTokens: 256,
            systemInstruction:
              'This is an adult developer audio transport test. Respond in Japanese. Keep each response to one very short sentence. Do not ask questions.',
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          },
        }),
      controller.signal,
    );
    while (!(await next()).setupComplete) {
      /* wait for setup acknowledgement */
    }
    session.sendClientContent({
      turns: [
        { role: 'user', parts: [{ text: 'Say only: \u3053\u3093\u306b\u3061\u306f\u3002' }] },
      ],
      turnComplete: true,
    });
    const audio = [];
    const receiveTurn = async (capture) => {
      let bytes = 0;
      for (;;) {
        const message = await next();
        const content = message.serverContent;
        if (!content) continue;
        ctx.metrics.inputTranscriptChars =
          (ctx.metrics.inputTranscriptChars ?? 0) + (content.inputTranscription?.text?.length ?? 0);
        ctx.metrics.outputTranscriptChars =
          (ctx.metrics.outputTranscriptChars ?? 0) +
          (content.outputTranscription?.text?.length ?? 0);
        for (const part of content.modelTurn?.parts ?? []) {
          if (part.inlineData?.mimeType?.startsWith('audio/pcm') && part.inlineData.data) {
            const chunk = Buffer.from(part.inlineData.data, 'base64');
            bytes += chunk.length;
            ensure(bytes <= 480_000, 'audio_not_observed');
            if (capture) audio.push(chunk);
          }
        }
        if (content.turnComplete) break;
      }
      ensure(bytes > 0, 'audio_not_observed');
      return bytes;
    };
    ctx.metrics.audioBytes = await receiveTurn(true);
    ensure(ctx.metrics.outputTranscriptChars > 0);
    const pcm = await resample(Buffer.concat(audio));
    ensure(pcm.length > 0 && pcm.some((byte) => byte !== 0), 'audio_not_observed');
    ctx.metrics.inputAudioBytes = pcm.length;
    session.sendRealtimeInput({ activityStart: {} });
    for (let offset = 0; offset < pcm.length; offset += 3200) {
      session.sendRealtimeInput({
        audio: {
          data: pcm.subarray(offset, offset + 3200).toString('base64'),
          mimeType: 'audio/pcm;rate=16000',
        },
      });
      await sleep(100);
    }
    session.sendRealtimeInput({ activityEnd: {} });
    ctx.metrics.audioBytes += await receiveTurn(false);
    ensure(ctx.metrics.inputTranscriptChars > 0);
  } finally {
    clearTimeout(timer);
    session?.close();
    queue.length = 0;
  }
}

async function adkLiveProbe(ctx) {
  const { adk, z, voiceModel: model, metrics, budget } = ctx;
  ensure(model, 'live_model_required');
  const controller = new AbortController();
  let connection;
  let connections = 0;
  const connect = model.connect.bind(model);
  model.connect = async (request) => {
    ensure(++connections === 1, 'call_budget');
    budget.take();
    request.liveConnectConfig ??= {};
    request.liveConnectConfig.maxOutputTokens = 256;
    request.liveConnectConfig.abortSignal = controller.signal;
    connection = await connectWithinSignal(() => connect(request), controller.signal);
    return connection;
  };
  let executions = 0;
  const tool = new adk.FunctionTool({
    name: 'read_test_status',
    description: 'Read the current synthetic audio diagnostic status.',
    parameters: z.object({}).strict(),
    execute: () => {
      ensure(++executions === 1);
      return { status: 'ready' };
    },
  });
  const agent = new adk.LlmAgent({
    name: 'adult_developer_live_diagnostic',
    model,
    tools: [tool],
    instruction:
      'You assist an adult developer with an audio connectivity test. Answer in one short sentence. Use the diagnostic tool to check status when asked.',
  });
  const runner = new adk.InMemoryRunner({ agent, appName: 'adult_developer_live_diagnostic' });
  const session = await runner.sessionService.createSession({
    appName: 'adult_developer_live_diagnostic',
    userId: 'synthetic',
  });
  const queue = new adk.LiveRequestQueue();
  queue.sendContent({
    role: 'user',
    parts: [{ text: 'Please check the current audio diagnostic status and tell me the result.' }],
  });
  let call = false;
  let response = false;
  let complete = false;
  const timer = setTimeout(() => {
    controller.abort();
    queue.close();
    void connection?.close();
  }, 45_000);
  try {
    for await (const event of runner.runLive({
      userId: 'synthetic',
      sessionId: session.id,
      liveRequestQueue: queue,
      runConfig: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      abortSignal: controller.signal,
    })) {
      ensure(!event.errorCode && !event.errorMessage, 'provider_error');
      for (const part of event.content?.parts ?? []) {
        if (part.functionCall?.name === tool.name) call = true;
        if (part.functionResponse?.name === tool.name) response = true;
        if (part.inlineData?.mimeType?.startsWith('audio/pcm') && part.inlineData.data)
          metrics.audioBytes =
            (metrics.audioBytes ?? 0) + Buffer.from(part.inlineData.data, 'base64').length;
      }
      metrics.outputTranscriptChars =
        (metrics.outputTranscriptChars ?? 0) + (event.outputTranscription?.text?.length ?? 0);
      ensure((metrics.audioBytes ?? 0) <= 480_000, 'audio_not_observed');
      if (event.turnComplete && call && response && metrics.audioBytes > 0) {
        complete = true;
        break;
      }
    }
    ensure(!controller.signal.aborted, 'timeout');
    ensure(complete && executions === 1 && metrics.outputTranscriptChars > 0);
    metrics.toolCalls = executions;
  } finally {
    clearTimeout(timer);
    controller.abort();
    queue.close();
    await connection?.close();
    await runner.sessionService.deleteSession({
      appName: 'adult_developer_live_diagnostic',
      userId: 'synthetic',
      sessionId: session.id,
    });
  }
}

async function worker(key, options) {
  const core = await localImport('packages/agent-core/dist/index.js');
  core.disableAdkContentCapture();
  const adk = await dependency('@google/adk');
  const { GoogleGenAI } = await dependency('@google/genai');
  const { z } = await dependency('zod');
  const loader = await localImport('packages/kb-loader/dist/index.js');
  const kb = await loader.Kb.load(new loader.FsKbSource(join(ROOT, 'kb/v0.1.0')));
  const budget = new Budget();
  const model = new adk.Gemini({ model: options.model, apiKey: key, vertexai: false });
  const voiceModel = options.liveModel
    ? new adk.Gemini({ model: options.liveModel, apiKey: key, vertexai: false })
    : null;
  const client = new GoogleGenAI({
    apiKey: key,
    vertexai: false,
    httpOptions: { timeout: 25_000, retryOptions: { attempts: 1 } },
  });
  key = '';
  const ctx = {
    core,
    adk,
    z,
    loader,
    kb,
    model,
    voiceModel,
    client,
    budget,
    metrics: {},
    lastError: undefined,
  };
  const generate = model.generateContentAsync.bind(model);
  let lastCall = 0;
  model.generateContentAsync = async function* (request, stream, signal) {
    budget.take();
    await sleep(Math.max(0, 5000 - (Date.now() - lastCall)));
    lastCall = Date.now();
    request.config = {
      ...request.config,
      maxOutputTokens: 1024,
      httpOptions: { timeout: 25_000, retryOptions: { attempts: 1 } },
    };
    try {
      for await (const response of generate(request, stream, signal)) {
        if (response.usageMetadata?.totalTokenCount && !response.partial)
          ctx.metrics.tokens = (ctx.metrics.tokens ?? 0) + response.usageMetadata.totalTokenCount;
        yield response;
      }
    } catch (error) {
      ctx.lastError = classify(error);
      const status = error?.status ?? error?.response?.status;
      if (Number.isInteger(status) && status >= 100 && status <= 599)
        ctx.metrics.httpStatus = status;
      throw error;
    } finally {
      ctx.metrics.modelMs = (ctx.metrics.modelMs ?? 0) + Date.now() - lastCall;
    }
  };
  let stopped = false;
  for (const id of options.cases) {
    const start = Date.now();
    const calls = budget.used;
    ctx.metrics = {};
    ctx.lastError = undefined;
    let category = 'verified';
    try {
      ensure(!stopped, 'previous_access_failure');
      if (['chat', 'tool', 'context'].includes(id)) await chatProbe(id, ctx);
      else if (id === 'live') await liveProbe(ctx, options);
      else if (id === 'adk-live') await adkLiveProbe(ctx);
      else if (id === 'embedding') {
        budget.take();
        const result = await client.models.embedContent({
          model: 'gemini-embedding-001',
          contents: [
            'How can I help a colleague who is being harassed?',
            'Listen without blame and help the colleague contact a trusted support person.',
            'A pasta recipe with tomatoes and olive oil.',
          ],
          config: { outputDimensionality: 128 },
        });
        ensure(verifyVectors(result.embeddings?.map((entry) => entry.values)));
      } else await structuredProbe(id, ctx);
    } catch (error) {
      category = ctx.lastError ?? classify(error);
      if (['unauthenticated', 'permission_denied', 'quota_exhausted'].includes(category))
        stopped = true;
    }
    process.send(
      safeRow({
        case: id,
        category,
        durationMs: Date.now() - start,
        calls: budget.used - calls,
        ...ctx.metrics,
      }),
    );
  }
}

async function hiddenKey() {
  ensure(process.stdin.isTTY && process.stdin.setRawMode, 'terminal_required');
  process.stderr.write('Adult-only synthetic test. Enter API key (hidden; never saved):\n');
  process.stdin.setRawMode(true);
  return new Promise((resolve, reject) => {
    let key = '';
    const finish = (ok) => {
      clearTimeout(timer);
      process.stdin.removeListener('data', read);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (ok && key.length >= 20 && key.length < 1024) resolve(key);
      else reject(new Error('key_input_cancelled'));
      key = '';
    };
    const timer = setTimeout(() => finish(false), 120_000);
    const read = (chunk) => {
      const value = chunk.toString();
      if (value.includes('\u0003')) return finish(false);
      key += value.replace(/[\r\n]/g, '');
      if (key.length >= 1024) finish(false);
      else if (/[\r\n]/.test(value)) finish(true);
    };
    process.stdin.on('data', read);
    process.stdin.resume();
  });
}

async function main() {
  if (process.env.GEMINI_DIAGNOSTIC_WORKER === '1' && process.send) {
    process.once('disconnect', () => process.exit(1));
    process.once('message', async ({ key, options }) => {
      try {
        await worker(key, options);
        key = '';
        process.removeAllListeners('disconnect');
        process.once('disconnect', () => process.exit(0));
        process.disconnect();
      } catch {
        process.send(safeRow({ category: 'worker_failed' }), () => process.exit(1));
      }
    });
    return;
  }
  if (process.argv.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/smoke-gemini-developer.mjs --run --model <pinned-model> [--live-model <pinned-model>] [--case chat,tool,...]\nAdult developers only. Fixed synthetic fixtures. Hidden terminal key input. No application backend, no real data.\n',
    );
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  let key = await hiddenKey();
  const rows = [];
  const start = Date.now();
  const child = fork(FILE, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
    env: {
      PATH: process.env.PATH,
      GEMINI_DIAGNOSTIC_WORKER: '1',
      ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false',
      OTEL_SDK_DISABLED: 'true',
    },
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
  child.on('message', (message) => {
    const row = safeRow(message);
    rows.push(row);
    process.stderr.write(`${JSON.stringify(row)}\n`);
  });
  child.send({ key, options });
  key = '';
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code));
  });
  clearTimeout(timer);
  for (const id of options.cases)
    if (!rows.some((row) => row.case === id))
      rows.push(safeRow({ case: id, category: code === null ? 'total_timeout' : 'worker_failed' }));
  process.stdout.write(
    JSON.stringify(
      {
        provider: 'Gemini Developer API',
        scope: 'adult_developer_synthetic_only',
        model: options.model,
        liveModel: options.liveModel ?? null,
        productionVerified: false,
        vertexVerified: false,
        childBrowserRealModelVerified: false,
        remainingFreeQuotaVerified: false,
        workerExitCode: code,
        durationMs: Date.now() - start,
        cases: rows,
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = diagnosticExitCode(rows, code);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write(
      'Diagnostic failed. Check --help, terminal input and local builds. No provider details logged.\n',
    );
    process.exitCode = 1;
  });
}
