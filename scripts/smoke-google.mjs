import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILE = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(FILE), '..');
const REGION = 'asia-northeast1';
const KB_VERSION = '0.1.0';
export const SYNTHETIC_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const coreRequire = createRequire(join(ROOT, 'packages/agent-core/package.json'));
const serviceRequire = createRequire(join(ROOT, 'packages/service-kit/package.json'));
export const LIMITS = Object.freeze({ caseMs: 25_000, totalMs: 180_000, calls: 8, graceMs: 250 });
export const CASES = Object.freeze({
  chat: { purpose: 'petChat', env: 'GEMINI_MODEL_PET_CHAT', calls: 1 },
  tool: { purpose: 'petChat', env: 'GEMINI_MODEL_PET_CHAT', calls: 2 },
  'crisis-screen': { purpose: 'crisisScreen', env: 'GEMINI_MODEL_CRISIS_SCREEN', calls: 1 },
  'crisis-review': { purpose: 'crisisReview', env: 'GEMINI_MODEL_CRISIS_REVIEW', calls: 1 },
  signal: { purpose: 'signalExtract', env: 'GEMINI_MODEL_SIGNAL_EXTRACT', calls: 1 },
  artwork: { purpose: 'artworkFeature', env: 'GEMINI_MODEL_ARTWORK_FEATURE', calls: 1 },
  live: { purpose: 'petVoice', env: 'GEMINI_MODEL_PET_VOICE', calls: 0 },
  rag: { calls: 1 },
});
const BLOCKED = new Set([
  'opt_in_required',
  'configuration_only',
  'project_required',
  'tokyo_required',
  'model_required',
  'adc_missing',
  'adc_invalid',
  'adc_unsupported',
  'build_required',
  'rag_corpus_required',
  'rag_tokyo_required',
  'rag_mapping_required',
  'live_tokyo_unavailable',
  'unauthenticated',
  'permission_denied',
  'model_unavailable',
  'quota_exhausted',
  'total_timeout',
  'call_budget',
]);
const FAILED = new Set([
  'invalid_arguments',
  'timeout',
  'provider_error',
  'request_rejected',
  'network_error',
  'invalid_json',
  'schema',
  'expectation_failed',
  'empty_output',
  'tool_not_observed',
  'rag_not_observed',
  'kb_invalid',
  'worker_failed',
]);
const outcome = (category) => ({
  status: category === 'verified' ? 'pass' : BLOCKED.has(category) ? 'blocked' : 'fail',
  category:
    category === 'verified' || BLOCKED.has(category) || FAILED.has(category)
      ? category
      : 'provider_error',
});
class SmokeError extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}
const demand = (condition, category) => {
  if (!condition) throw new SmokeError(category);
};

// Never use provider messages, stacks, URLs, response bodies, or tokens as report fields.
export function classifyError(error) {
  if (error instanceof SmokeError) return outcome(error.category);
  const status = error?.status ?? error?.response?.status;
  const categories = {
    401: 'unauthenticated',
    403: 'permission_denied',
    404: 'model_unavailable',
    429: 'quota_exhausted',
    400: 'request_rejected',
  };
  if (categories[status]) return outcome(categories[status]);
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return outcome('timeout');
  if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND')
    return outcome('build_required');
  if (['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error?.code))
    return outcome('network_error');
  return outcome('provider_error');
}

export function sanitizeOutcome(value) {
  const safe = outcome(value?.category);
  return value?.status === safe.status && value?.category === safe.category
    ? safe
    : outcome('worker_failed');
}

export function parseArgs(args) {
  let mode;
  const selected = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help') return { help: true, cases: [] };
    if (arg === '--check' || arg === '--vertex') {
      demand(!mode, 'invalid_arguments');
      mode = arg.slice(2);
    } else if (arg === '--case' || arg.startsWith('--case=')) {
      const value = arg === '--case' ? args[++i] : arg.slice(7);
      demand(typeof value === 'string' && value.length > 0, 'invalid_arguments');
      selected.push(...value.split(','));
    } else throw new SmokeError('invalid_arguments');
  }
  demand(
    selected.every((id) => Object.hasOwn(CASES, id)),
    'invalid_arguments',
  );
  return { mode, cases: selected.length ? [...new Set(selected)] : Object.keys(CASES) };
}

function modelId(id, env) {
  const value = env[CASES[id]?.env];
  return typeof value === 'string' &&
    value.length < 100 &&
    /^gemini-(?:live-)?\d+(?:\.\d+)?-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value) &&
    !/(?:latest|auto|alias)/.test(value)
    ? value
    : null;
}

// Local file inspection only: no SDK imports, token refresh, gcloud or metadata lookup.
export function preflight(id, env, io = { existsSync, readFileSync, statSync }) {
  try {
    demand(Object.hasOwn(CASES, id), 'invalid_arguments');
    demand(
      /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.GCP_PROJECT_ID ?? '') &&
        !env.GCP_PROJECT_ID.startsWith('demo'),
      'project_required',
    );
    demand(env.GCP_REGION === REGION, 'tokyo_required');
    // 2026-10-01: the parent task verified no supported native-audio model in Tokyo.
    // This is deliberately not an environment override. Revisit after region authorization.
    demand(id !== 'live', 'live_tokyo_unavailable');
    if (id !== 'rag') demand(modelId(id, env), 'model_required');
    if (id === 'rag') {
      demand(env.PET_RAG_CORPUS, 'rag_corpus_required');
      demand(
        /^projects\/[a-z0-9-]+\/locations\/asia-northeast1\/ragCorpora\/[a-zA-Z0-9_-]+$/.test(
          env.PET_RAG_CORPUS,
        ),
        'rag_tokyo_required',
      );
      let mapping;
      try {
        mapping = JSON.parse(env.PET_RAG_SKILL_SOURCES_JSON ?? 'null');
      } catch {
        /* fixed category below */
      }
      demand(
        env.PET_RAG_KB_VERSION === KB_VERSION &&
          mapping &&
          !Array.isArray(mapping) &&
          typeof mapping === 'object' &&
          Object.keys(mapping).length > 0 &&
          Object.values(mapping).every(
            (v) => typeof v === 'string' && /^skills\/[\w/-]+\.md$/.test(v),
          ),
        'rag_mapping_required',
      );
    }
    const adcPath =
      env.GOOGLE_APPLICATION_CREDENTIALS ||
      join(
        env.CLOUDSDK_CONFIG || join(env.HOME || homedir(), '.config/gcloud'),
        'application_default_credentials.json',
      );
    demand(io.existsSync(adcPath), 'adc_missing');
    let credentials;
    try {
      const stat = io.statSync(adcPath);
      demand(stat.isFile() && stat.size <= 1_048_576, 'adc_invalid');
      credentials = JSON.parse(io.readFileSync(adcPath, 'utf8'));
    } catch {
      throw new SmokeError('adc_invalid');
    }
    demand(credentials && typeof credentials === 'object', 'adc_invalid');
    const fields =
      credentials.type === 'authorized_user'
        ? ['client_id', 'client_secret', 'refresh_token']
        : credentials.type === 'service_account'
          ? ['client_email', 'private_key', 'project_id']
          : null;
    demand(fields, 'adc_unsupported');
    demand(
      fields.every((key) => typeof credentials[key] === 'string' && credentials[key].length > 0),
      'adc_invalid',
    );
    const files = [
      'packages/agent-core/dist/index.js',
      'packages/kb-loader/dist/index.js',
      `kb/v${KB_VERSION}/manifest.json`,
    ];
    if (id === 'rag') files.push('services/pet-agent/dist/skills.js');
    demand(
      files.every((file) => io.existsSync(join(ROOT, file))),
      'build_required',
    );
    return { ...outcome('configuration_only'), adcPath };
  } catch (error) {
    return classifyError(error);
  }
}

// Only required environment reaches SDKs. Excludes API keys, custom endpoints and tracing hooks.
function workerEnv(env, adcPath) {
  const keys = [
    'PATH',
    'HOME',
    'TMPDIR',
    'GCP_PROJECT_ID',
    'GCP_REGION',
    'PET_RAG_CORPUS',
    'PET_RAG_KB_VERSION',
    'PET_RAG_SKILL_SOURCES_JSON',
    ...Object.values(CASES)
      .map((item) => item.env)
      .filter(Boolean),
  ];
  return {
    ...Object.fromEntries(
      keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]),
    ),
    GOOGLE_APPLICATION_CREDENTIALS: adcPath,
    ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false',
    OTEL_SDK_DISABLED: 'true',
    NODE_ENV: 'test',
    SMOKE_GOOGLE_WORKER: '1',
  };
}

export function runBoundedCase(id, env, adcPath, timeoutMs = LIMITS.caseMs, launch = fork) {
  return new Promise((resolveResult) => {
    let result;
    let timedOut = false;
    let killTimer;
    const child = launch(FILE, ['--vertex', '--case', id], {
      cwd: ROOT,
      env: workerEnv(env, adcPath),
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const timer = setTimeout(
      () => {
        timedOut = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), LIMITS.graceMs);
      },
      Math.max(1, Math.min(timeoutMs, LIMITS.caseMs)),
    );
    child.on('message', (message) => {
      result = sanitizeOutcome(message);
    });
    child.on('error', () => {
      result = outcome('worker_failed');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolveResult(
        timedOut ? outcome('timeout') : code === 0 && result ? result : outcome('worker_failed'),
      );
    });
  });
}

export async function runSmoke(args, env = process.env, hooks = {}) {
  const start = Date.now();
  const report = {
    mode: 'none',
    startedAt: new Date(start).toISOString(),
    durationMs: 0,
    cases: [],
  };
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    report.cases.push({ case: 'cli', modelId: null, ...classifyError(error), durationMs: 0 });
    return { report, exitCode: 1 };
  }
  if (options.help) return { help: true, exitCode: 0 };
  report.mode = options.mode ?? 'none';
  let reserved = 0;
  let authFailure;
  for (const id of options.cases) {
    const began = Date.now();
    let result = outcome('opt_in_required');
    if (options.mode) {
      const config = (hooks.preflight ?? preflight)(id, env);
      result = sanitizeOutcome(config);
      if (config.category === 'configuration_only' && options.mode === 'vertex') {
        const remaining = LIMITS.totalMs - (Date.now() - start);
        if (authFailure) result = outcome(authFailure);
        else if (remaining <= LIMITS.graceMs) result = outcome('total_timeout');
        else if (reserved + CASES[id].calls > LIMITS.calls) result = outcome('call_budget');
        else {
          reserved += CASES[id].calls;
          try {
            result = sanitizeOutcome(
              await (hooks.runCase ?? runBoundedCase)(
                id,
                env,
                config.adcPath,
                Math.min(LIMITS.caseMs, remaining - LIMITS.graceMs),
              ),
            );
          } catch (error) {
            result = classifyError(error);
          }
          if (result.category === 'unauthenticated') authFailure = result.category;
        }
      }
    }
    report.cases.push({
      case: id,
      modelId: modelId(id, env),
      ...result,
      durationMs: Date.now() - began,
    });
  }
  report.durationMs = Date.now() - start;
  const failures = report.cases.some((row) => row.status === 'fail');
  const blocked = report.cases.some(
    (row) => row.status === 'blocked' && row.category !== 'configuration_only',
  );
  return { report, exitCode: failures ? 1 : blocked ? 2 : 0 };
}

async function importLocal(path) {
  return import(pathToFileURL(join(ROOT, path)).href);
}

// Model-level transport limits also cover calls made internally by ADK's runner.
export function boundedModel(core, purpose, env, signal, limit) {
  const model = core.createGemini(purpose, { projectId: env.GCP_PROJECT_ID, location: REGION });
  const generate = model.generateContentAsync.bind(model);
  let calls = 0;
  model.generateContentAsync = async function* (request, stream, upstreamSignal) {
    const requestSignal = upstreamSignal ? AbortSignal.any([signal, upstreamSignal]) : signal;
    demand(!requestSignal.aborted, 'timeout');
    demand(++calls <= limit, 'call_budget');
    request.config = {
      ...request.config,
      maxOutputTokens: 2048,
      httpOptions: { timeout: 18_000, retryOptions: { attempts: 1 } },
    };
    yield* generate(request, stream, requestSignal);
  };
  return model;
}

async function chatProbe(id, core, model, signal) {
  const { FunctionTool, InMemoryRunner } = await import(
    pathToFileURL(coreRequire.resolve('@google/adk')).href
  );
  const { z } = await import(pathToFileURL(coreRequire.resolve('zod')).href);
  const receipt = randomBytes(12).toString('hex');
  let executions = 0;
  const tool = new FunctionTool({
    name: 'read_test_receipt',
    description: 'Read the current synthetic diagnostic receipt.',
    parameters: z.object({}).strict(),
    execute: () => {
      demand(++executions === 1, 'expectation_failed');
      return { receipt };
    },
  });
  const agent = core.createPetAgent({
    model,
    instruction: 'This is an adult-authored synthetic diagnostic. Answer briefly and accurately.',
    tools: id === 'tool' ? [tool] : [],
    temperature: 0,
  });
  const runner = new InMemoryRunner({ agent, appName: 'google_smoke' });
  const session = await runner.sessionService.createSession({
    appName: 'google_smoke',
    userId: 'synthetic',
  });
  let callSeen = false;
  let responseSeen = false;
  let finalText = '';
  try {
    for await (const event of runner.runAsync({
      userId: 'synthetic',
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [
          {
            text:
              id === 'tool'
                ? 'What is the current test receipt? Include its exact value.'
                : 'Say hello in one short sentence.',
          },
        ],
      },
      runConfig: { maxLlmCalls: CASES[id].calls },
      abortSignal: signal,
    })) {
      demand(!event.errorCode && !event.errorMessage, 'provider_error');
      for (const part of event.content?.parts ?? []) {
        if (part.functionCall?.name === tool.name) callSeen = true;
        if (part.functionResponse?.name === tool.name) responseSeen = true;
      }
      if (
        event.content?.role === 'model' &&
        !event.partial &&
        !event.content.parts?.some((part) => part.functionCall)
      )
        finalText = (event.content.parts ?? [])
          .filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('');
    }
    demand(finalText.trim().length > 0, 'empty_output');
    if (id === 'tool')
      demand(
        callSeen && responseSeen && executions === 1 && finalText.includes(receipt),
        'tool_not_observed',
      );
  } finally {
    await runner.sessionService.deleteSession({
      appName: 'google_smoke',
      userId: 'synthetic',
      sessionId: session.id,
    });
  }
}

async function structuredProbe(id, core, model, kb, loader, signal) {
  const name = {
    'crisis-screen': 'crisis_screen',
    'crisis-review': 'crisis_review',
    signal: 'signal_extract',
    artwork: 'artwork_feature',
  }[id];
  const schema = JSON.parse(await kb.text(`schemas/${name}.json`));
  let prompt = (await kb.text(`prompts/${name}.md`)).replaceAll('{gradeBand}', 'high');
  // Synthetic Japanese fixtures; no child input is read by this CLI.
  const ordinary =
    '\u304d\u3087\u3046\u306f\u53cb\u3060\u3061\u3068\u516c\u5712\u3067\u904a\u3093\u3060';
  const danger =
    '\u4eca\u304a\u7236\u3055\u3093\u306b\u6bb4\u3089\u308c\u3066\u3044\u3066\u3001\u5bb6\u306b\u3044\u308b\u306e\u304c\u6016\u3044';
  let input = JSON.stringify({
    latest: id === 'crisis-review' ? danger : ordinary,
    priorTurns: [],
  });
  let defs = [];
  if (id === 'signal') {
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
    input = JSON.stringify({ current: { role: 'child', turnIndex: 0, text: ordinary }, prior: [] });
  }
  if (id === 'artwork') {
    prompt = prompt
      .replace('{type}', 'story')
      .replace('{narrative}', 'A synthetic blank image, no people.');
    input = [
      { text: 'A synthetic blank image, no people.' },
      { inlineData: { mimeType: 'image/png', data: SYNTHETIC_PNG } },
    ];
  }
  const agent = core.createExtractorAgent({
    name,
    description: 'Synthetic schema smoke probe',
    model,
    instruction: () => prompt,
    outputSchema: core.toGenaiSchema(schema),
    temperature: 0,
  });
  const result = await core.runStructured(agent, input, {
    schema,
    maxAttempts: 1,
    timeoutMs: 20_000,
    signal,
  });
  if (!result.ok)
    throw new SmokeError(result.reason === 'model_error' ? 'provider_error' : result.reason);
  const value = result.value;
  if (id === 'crisis-screen') demand(value.suspect === false, 'expectation_failed');
  if (id === 'crisis-review')
    demand(
      value.hit === true &&
        value.category === 'family_harm' &&
        value.evidenceSpan?.length > 0 &&
        danger.includes(value.evidenceSpan),
      'expectation_failed',
    );
  if (id === 'signal')
    demand(
      value.signals.every((item) =>
        defs.some((def) => def.signal_id === item.signalDefId && (!item.explicit || def.explicit)),
      ),
      'expectation_failed',
    );
  if (id === 'artwork') demand(value.explicitHarm === false, 'expectation_failed');
}

async function ragProbe(env, kb, signal) {
  const { createSkillSearch } = await importLocal('services/pet-agent/dist/skills.js');
  const { GoogleAuth } = await import(
    pathToFileURL(serviceRequire.resolve('google-auth-library')).href
  );
  const auth = new GoogleAuth({
    keyFilename: env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  let calls = 0;
  const expected = `https://${REGION}-aiplatform.googleapis.com/v1/${env.PET_RAG_CORPUS.split('/ragCorpora/')[0]}:retrieveContexts`;
  const search = await createSkillSearch(kb, env, {
    request: async (request) => {
      demand(++calls === 1 && request.method === 'POST' && request.url === expected, 'call_budget');
      // Fetch once after authentication: GoogleAuth.request may replay a 401/403 response.
      const headers = await client.getRequestHeaders(request.url);
      headers.set('Content-Type', 'application/json');
      const response = await fetch(request.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(18_000)]),
      });
      if (!response.ok) throw new SmokeError(classifyError({ status: response.status }).category);
      return response.json();
    },
  });
  const results = await search(
    '\u4fe1\u983c\u3067\u304d\u308b\u5927\u4eba\u3084\u53cb\u3060\u3061\u306b\u8a71\u3059',
  );
  demand(calls === 1 && results.length > 0 && results.length <= 3, 'rag_not_observed');
}

async function worker(id, env, signal) {
  // Guards precede every dynamic import, including on direct invocation of the child entry.
  const config = preflight(id, env);
  if (config.category !== 'configuration_only') return sanitizeOutcome(config);
  try {
    const core = await importLocal('packages/agent-core/dist/index.js');
    core.disableAdkContentCapture();
    const loader = await importLocal('packages/kb-loader/dist/index.js');
    let kb;
    try {
      kb = await loader.Kb.load(new loader.FsKbSource(join(ROOT, `kb/v${KB_VERSION}`)));
    } catch {
      throw new SmokeError('kb_invalid');
    }
    if (id === 'rag') await ragProbe(env, kb, signal);
    else {
      const model = boundedModel(core, CASES[id].purpose, env, signal, CASES[id].calls);
      if (id === 'chat' || id === 'tool') await chatProbe(id, core, model, signal);
      else await structuredProbe(id, core, model, kb, loader, signal);
    }
    demand(!signal.aborted, 'timeout');
    return outcome('verified');
  } catch (error) {
    return signal.aborted ? outcome('timeout') : classifyError(error);
  }
}

async function main() {
  if (process.env.SMOKE_GOOGLE_WORKER === '1' && process.send) {
    let result;
    const controller = new AbortController();
    process.once('SIGTERM', () => controller.abort());
    process.once('disconnect', () => {
      controller.abort();
      setTimeout(() => process.exit(1), LIMITS.graceMs).unref();
    });
    const timer = setTimeout(() => controller.abort(), LIMITS.caseMs - 1000);
    try {
      const options = parseArgs(process.argv.slice(2));
      demand(options.mode === 'vertex' && options.cases.length === 1, 'opt_in_required');
      result = await worker(options.cases[0], process.env, controller.signal);
    } catch (error) {
      result = classifyError(error);
    } finally {
      clearTimeout(timer);
    }
    // IPC contains only our allowlisted classification; process exit closes all remaining sockets.
    process.send(sanitizeOutcome(result), () => process.exit(0));
    return;
  }
  const result = await runSmoke(process.argv.slice(2));
  process.stdout.write(
    result.help
      ? 'Usage: node scripts/smoke-google.mjs --check|--vertex [--case chat,tool,crisis-screen,crisis-review,signal,artwork,live,rag]\n' +
          '--check is local only. --vertex opts into billed model/retrieval calls. All cases are selected by default.\n' +
          'Requires GCP_PROJECT_ID, GCP_REGION=asia-northeast1, explicit GEMINI_MODEL_* and local ADC.\n' +
          'Live is blocked pending Tokyo availability/region authorization; no microphone path is tested.\n'
      : `${JSON.stringify(result.report)}\n`,
  );
  process.exitCode = result.exitCode;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stdout.write(`${JSON.stringify({ status: 'fail', category: 'worker_failed' })}\n`);
    process.exitCode = 1;
  });
}
