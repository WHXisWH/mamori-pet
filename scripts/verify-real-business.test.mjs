import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  assertEmulator,
  assertIsolatedProject,
  assertWorkerEnvironment,
  allowHttp,
  boundedModel,
  CallBudget,
  CASES,
  createEventQueue,
  createRealBusinessRuntime,
  DEFAULT_CASES,
  LIMITS,
  parseArgs,
  preflight,
  PROJECT,
  readSse,
  REGION,
  ROOT,
  runBoundedCase,
  runVerification,
  sanitizeCase,
  validateOrigins,
  VerificationError,
  workerEnv,
} from './verify-real-business.mjs';

const FILE = join(ROOT, 'scripts/verify-real-business.mjs');
const PROJECT_ID = 'demo-real-12345678-1234-4234-9234-123456789abc';
const SECRET = 'SECRET_TRANSCRIPT_REFRESH_TOKEN_NEVER_PRINT';
const env = () => ({
  NODE_ENV: 'test',
  GCP_PROJECT_ID: PROJECT,
  GCP_REGION: REGION,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:9095',
  REAL_BUSINESS_APPROVED: '1',
  GOOGLE_APPLICATION_CREDENTIALS: '/tmp/synthetic-adc.json',
  GEMINI_MODEL_PET_CHAT: 'gemini-2.5-flash',
  GEMINI_MODEL_CRISIS_SCREEN: 'gemini-2.5-flash',
  GEMINI_MODEL_CRISIS_REVIEW: 'gemini-2.5-flash',
  GEMINI_MODEL_SIGNAL_EXTRACT: 'gemini-2.5-flash',
  GEMINI_MODEL_NOTIFICATION_WRITER: 'gemini-2.5-flash',
});
const adc = {
  type: 'authorized_user',
  client_id: 'synthetic',
  client_secret: SECRET,
  refresh_token: SECRET,
};
const io = (credential = adc) => ({
  existsSync: () => true,
  readFileSync: () => JSON.stringify(credential),
  statSync: (path) => ({ isFile: () => true, size: 300, mtimeMs: path.includes('/dist/') ? 2 : 1 }),
  readdirSync: () => [{ name: 'index.ts', isDirectory: () => false }],
});
const code = (expected) => (error) => error instanceof VerificationError && error.code === expected;

test('import and no-opt-in CLI do not refresh ADC, start services or print inherited secrets', () => {
  const imported = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `globalThis.fetch = () => { throw new Error('network'); }; await import(${JSON.stringify(pathToFileURL(FILE).href)});`,
    ],
    { env: { ...env(), GOOGLE_API_KEY: SECRET }, encoding: 'utf8', timeout: 3000 },
  );
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  const cli = spawnSync(process.execPath, [FILE], {
    env: { ...env(), GOOGLE_API_KEY: SECRET },
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(cli.status, 2);
  assert.equal(JSON.parse(cli.stdout).code, 'opt_in_required');
  assert.ok(!`${cli.stdout}${cli.stderr}`.includes(SECRET));
});

test('CLI accepts bounded selections and rejects ambiguous or unknown options', () => {
  assert.deepEqual(parseArgs(['--run']).cases, DEFAULT_CASES);
  assert.equal(
    DEFAULT_CASES.reduce((n, id) => n + CASES[id].calls, 0),
    21,
  );
  assert.equal(LIMITS.calls, 30);
  assert.equal(CASES.memory.calls, 18);
  assert.equal(CASES.extensions.calls, 10);
  assert.ok(!DEFAULT_CASES.includes('memory'));
  assert.ok(!DEFAULT_CASES.includes('extensions'));
  assert.deepEqual(parseArgs(['--run', '--case', 'memory,extensions']).cases, [
    'memory',
    'extensions',
  ]);
  assert.equal(CASES.help.calls, 5);
  assert.equal(CASES.pipeline.calls, 7);
  assert.deepEqual(parseArgs(['--run', '--case', 'safety']).cases, ['safety']);
  assert.deepEqual(parseArgs(['--check', '--case', 'memory,memory']).cases, ['memory']);
  assert.equal(
    parseArgs(['--check', '--output', '/tmp/new-report.json']).output,
    '/tmp/new-report.json',
  );
  for (const args of [
    ['--run', '--check'],
    ['--run', '--case', 'unknown'],
    ['--run', '--case'],
    ['--run', '--case', ''],
    ['--relaxed'],
    ['--run', '--output'],
    ['--run', '--output', '--case'],
  ])
    assert.throws(() => parseArgs(args), code('invalid_arguments'));
});

test('Firestore guards reject cloud projects, reused demo names and noncanonical loopback endpoints', () => {
  assert.equal(assertIsolatedProject(PROJECT_ID), PROJECT_ID);
  for (const project of [
    PROJECT,
    'demo-ijime',
    'demo-real-1234',
    'demo-live-1234',
    `${PROJECT_ID}/documents`,
    undefined,
  ])
    assert.throws(() => assertIsolatedProject(project), code('isolated_project_required'));
  assert.equal(assertEmulator('127.0.0.1:9095'), '127.0.0.1:9095');
  for (const host of [
    undefined,
    'localhost:9095',
    '0.0.0.0:9095',
    '127.0.0.1:80',
    '127.0.0.1:65536',
    'http://127.0.0.1:9095',
    '127.0.0.1:09095',
    '127.0.0.1:9095/path',
    '127.0.0.1.evil.test:9095',
    'firestore.googleapis.com:443',
    '127.1:9095',
  ])
    assert.throws(() => assertEmulator(host), code('emulator_required'));
});

test('preview CORS only accepts explicit HTTP loopback origins on unprivileged ports', () => {
  assert.deepEqual(
    validateOrigins(['http://127.0.0.1:3000', 'http://localhost:3001', 'http://[::1]:3100']),
    ['http://127.0.0.1:3000', 'http://localhost:3001', 'http://[::1]:3100'],
  );
  for (const origin of [
    '*',
    'null',
    'https://localhost:3000',
    'http://localhost',
    'http://localhost:80',
    'http://127.0.0.1:3000/path',
    'http://localhost:3000/',
    'http://localhost:3000?token=x',
    'http://user:pass@localhost:3000',
    'http://localhost.evil.test:3000',
    'http://0.0.0.0:3000',
    'http://127.0.0.1:65536',
    'file:///tmp/test',
    null,
  ])
    assert.throws(() => validateOrigins([origin]), code('invalid_arguments'));
});

test('preflight is file-only and rejects unapproved runs and wrong cloud target', () => {
  assert.deepEqual(preflight(parseArgs(['--check']), env(), io()), {
    adcPath: '/tmp/synthetic-adc.json',
  });
  const changed = [
    ['NODE_ENV', 'production', 'test_environment_required'],
    ['GCP_PROJECT_ID', 'production-data', 'project_required'],
    ['GCP_REGION', 'global', 'region_required'],
    ['FIRESTORE_EMULATOR_HOST', '', 'emulator_required'],
    ['REAL_BUSINESS_APPROVED', '', 'approval_required'],
    ['GEMINI_MODEL_PET_CHAT', 'gemini-latest', 'model_required'],
    ['GEMINI_MODEL_CRISIS_SCREEN', `gemini-${SECRET}`, 'model_required'],
  ];
  for (const [key, value, expected] of changed)
    assert.throws(
      () => preflight(parseArgs(['--run']), { ...env(), [key]: value }, io()),
      code(expected),
    );
  assert.doesNotThrow(() =>
    preflight(parseArgs(['--check']), { ...env(), REAL_BUSINESS_APPROVED: '' }, io()),
  );
});

test('output preflight rejects existing files, directories and dangling symlinks before ADC or workers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'real-business-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const existing = join(dir, 'existing.json');
  const dangling = join(dir, 'dangling.json');
  writeFileSync(existing, SECRET, { flag: 'wx' });
  symlinkSync(join(dir, 'missing.json'), dangling);
  for (const output of [existing, dir, dangling]) {
    const result = await runVerification(['--run', '--output', output], env(), {
      preflight: (options, e) =>
        preflight(options, e, {
          ...io(),
          lstatSync,
          readFileSync: () => assert.fail('output must be checked before ADC'),
        }),
      runCase: () => assert.fail('existing output must not launch a worker'),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.code, 'output_exists');
    assert.equal(result.report.modelCalls, 0);
    assert.equal(result.report.transportCalls, 0);
    assert.equal(result.output, undefined);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
  assert.equal(readFileSync(existing, 'utf8'), SECRET);
  const cli = spawnSync(process.execPath, [FILE, '--run', '--output', existing], {
    env: env(),
    encoding: 'utf8',
    timeout: 3000,
  });
  assert.equal(cli.status, 2);
  assert.equal(JSON.parse(cli.stdout).code, 'output_exists');
  assert.ok(!`${cli.stdout}${cli.stderr}`.includes(SECRET));
  assert.equal(readFileSync(existing, 'utf8'), SECRET);
  const fresh = join(dir, 'new.json');
  assert.doesNotThrow(() =>
    preflight(parseArgs(['--check', '--output', fresh]), env(), {
      ...io(),
      lstatSync,
    }),
  );
  assert.equal(lstatSync(fresh, { throwIfNoEntry: false }), undefined);
});

test('output inspection errors fail closed without printing filesystem details', async () => {
  const result = await runVerification(['--run', '--output', '/tmp/new.json'], env(), {
    preflight: (options, e) =>
      preflight(options, e, {
        ...io(),
        lstatSync: () => {
          throw new Error(SECRET);
        },
      }),
    runCase: () => assert.fail('must not run'),
  });
  assert.equal(result.report.code, 'output_failed');
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, undefined);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('ADC inspection refuses federation, alternate token endpoints and unexpected quota project without output', () => {
  for (const extra of [
    { type: 'external_account' },
    { token_uri: 'https://evil.test/token' },
    { universe_domain: 'evil.test' },
    { service_account_impersonation_url: 'https://iamcredentials.googleapis.com/x' },
    { credential_source: { file: SECRET } },
    { quota_project_id: 'other-project' },
    { refresh_token: '' },
  ])
    assert.throws(
      () => preflight(parseArgs(['--check']), env(), io({ ...adc, ...extra })),
      code('adc_invalid'),
    );
  assert.throws(
    () => preflight(parseArgs(['--check']), env(), { ...io(), existsSync: () => false }),
    code('adc_missing'),
  );
  assert.throws(
    () => preflight(parseArgs(['--check']), env(), { ...io(), readFileSync: () => SECRET }),
    code('adc_invalid'),
  );
});

test('preflight requires current compiled source files, not stale dist artifacts', () => {
  assert.throws(
    () =>
      preflight(parseArgs(['--check']), env(), {
        ...io(),
        statSync: (path) => ({
          isFile: () => true,
          size: 300,
          mtimeMs: path.includes('/dist/') ? 1 : 3,
        }),
      }),
    code('build_required'),
  );
  assert.throws(
    () =>
      preflight(parseArgs(['--check']), env(), {
        ...io(),
        existsSync: (path) => !path.endsWith('/dist/index.js'),
      }),
    code('build_required'),
  );
});

test('worker environment excludes external writers, credential overrides and arbitrary secrets', () => {
  const original = {
    ...env(),
    GOOGLE_API_KEY: SECRET,
    GEMINI_API_KEY: SECRET,
    GOOGLE_GENAI_API_KEY: SECRET,
    GOOGLE_VERTEX_BASE_URL: 'https://evil.test',
    GOOGLE_GEMINI_BASE_URL: 'https://evil.test',
    ARTWORKS_BUCKET: 'private',
    PET_RAG_CORPUS: 'private',
    GOOGLE_OAUTH_CLIENT_SECRET: SECRET,
    PUBSUB_EMULATOR_HOST: 'evil.test:9099',
    BIGQUERY_DATASET: 'production',
    HTTPS_PROXY: 'https://evil.test',
    NODE_OPTIONS: '--require malicious.js',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://evil.test',
    TASKS_INVOKER_SA: 'private',
    SELF_URL: 'https://evil.test',
    SECRET,
  };
  const worker = workerEnv(original, '/tmp/adc.json', PROJECT_ID);
  assert.ok(!JSON.stringify(worker).includes(SECRET));
  assert.equal(worker.REAL_BUSINESS_PROJECT, PROJECT_ID);
  assert.equal(worker.FIRESTORE_EMULATOR_HOST, '127.0.0.1:9095');
  assert.equal(worker.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS, 'false');
  assert.equal(worker.OTEL_SDK_DISABLED, 'true');
  assert.equal(worker.NODE_OPTIONS, undefined);
  assert.equal(original.GOOGLE_API_KEY, SECRET);
});

test('worker validation accepts only the canonical macOS startup encoding exception', () => {
  const adcPath = '/tmp/synthetic-adc.json';
  const worker = workerEnv(env(), adcPath, PROJECT_ID);
  assert.doesNotThrow(() => assertWorkerEnvironment(worker, adcPath, PROJECT_ID));
  assert.doesNotThrow(() =>
    assertWorkerEnvironment(
      { ...worker, __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' },
      adcPath,
      PROJECT_ID,
      'darwin',
    ),
  );
  for (const value of [SECRET, '', '0x1F5:0x0', '0x1F5:0x0:0x0\n', 'https://remote.test'])
    assert.throws(
      () =>
        assertWorkerEnvironment(
          { ...worker, __CF_USER_TEXT_ENCODING: value },
          adcPath,
          PROJECT_ID,
          'darwin',
        ),
      code('configuration_changed'),
    );
  assert.throws(
    () =>
      assertWorkerEnvironment(
        { ...worker, __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0' },
        adcPath,
        PROJECT_ID,
        'linux',
      ),
    code('configuration_changed'),
  );
  for (const extra of [
    { FIREBASE_CONFIG: SECRET },
    { NODE_OPTIONS: SECRET },
    { HTTPS_PROXY: 'https://remote.test' },
    { GOOGLE_API_KEY: SECRET },
    { GOOGLE_VERTEX_BASE_URL: 'https://remote.test' },
    { ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'true' },
    { GOOGLE_CLOUD_PROJECT: 'other-project' },
  ])
    assert.throws(
      () => assertWorkerEnvironment({ ...worker, ...extra }, adcPath, PROJECT_ID),
      code('configuration_changed'),
    );
});

test(
  'actual fork accepts its OS-augmented sanitized environment without SDK or cloud access',
  { timeout: 5000 },
  async () => {
    const adcPath = '/tmp/synthetic-adc.json';
    const worker = workerEnv(
      { ...env(), FIREBASE_CONFIG: SECRET, GCLOUD_PROJECT: 'other-project' },
      adcPath,
      PROJECT_ID,
    );
    const script = `
    process.argv[1] = 'offline-environment-probe';
    globalThis.fetch = () => { throw new Error('offline test forbids network'); };
    const { assertWorkerEnvironment } = await import(${JSON.stringify(pathToFileURL(FILE).href)});
    let report = { status: 'pass' };
    try { assertWorkerEnvironment(process.env, ${JSON.stringify(adcPath)}, ${JSON.stringify(PROJECT_ID)}); }
    catch { report = { status: 'fail' }; process.exitCode = 1; }
    process.send(report, () => process.disconnect());
  `;
    const child = fork(FILE, [], {
      env: worker,
      execArgv: ['--input-type=module', '--eval', script],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let report;
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    const exitCode = await new Promise((resolve, reject) => {
      child.on('message', (message) => {
        report = message;
      });
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(exitCode, 0);
    assert.deepEqual(report, { status: 'pass' });
  },
);

test('model transport allowlist denies production data, writes, other regions, redirects and credentials in URLs', () => {
  const endpoint = `https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse`;
  assert.equal(allowHttp(endpoint, 'POST', ['gemini-2.5-flash']), 'model');
  assert.equal(allowHttp('https://oauth2.googleapis.com/token', 'POST', []), 'auth');
  for (const url of [
    endpoint.replace(PROJECT, 'other-project'),
    endpoint.replaceAll(REGION, 'us-central1'),
    endpoint.replace(':streamGenerateContent?alt=sse', ':predict'),
    endpoint.replace('gemini-2.5-flash:', 'gemini-latest:'),
    'https://firestore.googleapis.com/v1/projects/x/databases/(default)/documents',
    'https://storage.googleapis.com/private/file',
    'https://pubsub.googleapis.com/v1/projects/x/topics/t:publish',
    'https://fcm.googleapis.com/v1/projects/x/messages:send',
    'https://cloudtasks.googleapis.com/v2/projects/x/tasks',
    'http://metadata.google.internal/computeMetadata/v1',
    endpoint.replace('https://', 'https://user:pass@'),
    'https://oauth2.googleapis.com/token?redirect=https://evil.test',
    endpoint.replace('?alt=sse', '?key=secret'),
    endpoint.replace(
      '/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      ':retrieveContexts',
    ),
  ])
    assert.throws(() => allowHttp(url, 'POST', ['gemini-2.5-flash']), code('network_blocked'));
  assert.throws(() => allowHttp(endpoint, 'GET', ['gemini-2.5-flash']), code('network_blocked'));
});

test('installed egress guard bounds actual fetch attempts and blocks non-emulator gRPC authorities offline', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import http2 from 'node:http2';
    import http from 'node:http';
    import https from 'node:https';
    const { installNetworkGuard, CallBudget } = await import(${JSON.stringify(pathToFileURL(FILE).href)});
    let fetches = 0, grpc = 0;
    globalThis.fetch = async (_url, init) => { fetches++; assert.equal(init.redirect, 'error'); return new Response('{}'); };
    http2.connect = () => { grpc++; return {}; };
    const budget = new CallBudget(1, Date.now() + 5000);
    installNetworkGuard(${JSON.stringify(env())}, budget, new AbortController().signal);
    const url = 'https://${REGION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/publishers/google/models/gemini-2.5-flash:generateContent';
    await fetch(url, { method: 'POST' });
    await assert.rejects(fetch(url, { method: 'POST' }), { code: 'call_budget' });
    await assert.rejects(fetch('https://firestore.googleapis.com/write', { method: 'POST' }), { code: 'network_blocked' });
    assert.throws(() => https.request('https://fcm.googleapis.com/send', { method: 'POST' }), { code: 'network_blocked' });
    assert.throws(() => http.get('http://metadata.google.internal'), { code: 'network_blocked' });
    assert.throws(() => http2.connect('https://firestore.googleapis.com'), { code: 'network_blocked' });
    http2.connect('http://127.0.0.1:9095');
    assert.equal(fetches, 1); assert.equal(grpc, 1); assert.equal(budget.transportCalls, 1);
  `,
    ],
    { encoding: 'utf8', timeout: 3000 },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
});

test('publication is queued until explicit drain; cascades run once after the response boundary', async () => {
  const schema = { parse: (payload) => ({ ...payload }) };
  const queue = createEventQueue({ message: schema, signal: schema, crisis: schema });
  const processed = [];
  let responseComplete = false;
  const routes = {
    message: [['worker', '/message']],
    signal: [['risk', '/signal']],
    crisis: [['notifier', '/crisis']],
  };
  await queue.publish('message', { synthetic: true });
  await queue.publish('crisis', { synthetic: true });
  assert.equal(processed.length, 0);
  responseComplete = true;
  const dispatch = async (target) => {
    assert.equal(responseComplete, true);
    processed.push(target);
    if (target === 'worker') await queue.publish('signal', { synthetic: true });
  };
  assert.equal(await queue.drain(routes, dispatch, ['message', 'signal']), 2);
  assert.deepEqual(processed, ['worker', 'risk']);
  assert.equal(queue.pending.length, 1);
  assert.equal(await queue.drain(routes, dispatch, ['message', 'signal']), 0);
  assert.equal(await queue.drain(routes, dispatch, ['crisis']), 1);
  assert.deepEqual(processed, ['worker', 'risk', 'notifier']);
});

test('failed queue dispatch retains the event and recursive drain is rejected', async () => {
  const queue = createEventQueue({ message: { parse: (value) => value } });
  const routes = { message: [['worker', '/message']] };
  await queue.publish('message', {});
  await assert.rejects(
    queue.drain(routes, async () => {
      await queue.drain(routes, async () => {}, ['message']);
    }, ['message']),
    code('invalid_arguments'),
  );
  assert.equal(queue.pending.length, 1);
  await assert.rejects(
    queue.drain(routes, async () => {
      throw new Error('synthetic failure');
    }, ['message']),
  );
  assert.equal(queue.pending.length, 1);
});

test('independent model and transport budgets count failed attempts and reject deadline overruns', () => {
  let now = 0;
  const budget = new CallBudget(2, 10, () => now);
  for (const kind of ['modelCalls', 'transportCalls']) {
    budget.take(kind);
    budget.take(kind);
    assert.throws(() => budget.take(kind), code('call_budget'));
    assert.equal(budget[kind], 2);
  }
  const expired = new CallBudget(30, 10, () => now);
  now = 10;
  assert.throws(() => expired.take('modelCalls'), code('deadline'));
  assert.throws(() => new CallBudget(31, 10), code('call_budget'));
});

test('bounded model preserves stricter caller limits and sends no second attempt after exhausted budget', async () => {
  const received = [];
  const core = {
    createGemini: () => ({
      async *generateContentAsync(request, stream, signal) {
        received.push({ config: request.config, stream, signal });
        yield { content: { parts: [{ text: SECRET }] } };
      },
    }),
  };
  const budget = new CallBudget(1, Date.now() + 5000);
  const controller = new AbortController();
  const model = boundedModel(core, 'petChat', budget, controller.signal);
  for await (const value of model.generateContentAsync(
    { config: { maxOutputTokens: 128, httpOptions: { timeout: 1234 } } },
    true,
  )) {
    assert.ok(value);
  }
  assert.equal(received[0].config.maxOutputTokens, 128);
  assert.equal(received[0].config.httpOptions.timeout, 1234);
  assert.deepEqual(received[0].config.httpOptions.retryOptions, { attempts: 1 });
  await assert.rejects(async () => {
    for await (const value of model.generateContentAsync({}, true)) {
      assert.ok(value);
    }
  }, code('call_budget'));
  assert.equal(received.length, 1);
  const aborted = new AbortController();
  aborted.abort();
  const never = boundedModel(core, 'petChat', new CallBudget(2, Date.now() + 5000), aborted.signal);
  await assert.rejects(async () => {
    for await (const value of never.generateContentAsync({}, true)) {
      assert.ok(value);
    }
  }, code('deadline'));
});

test('real production Gemini adapter composes with harness caps offline', async (t) => {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env())) process.env[key] = value;
  process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS = 'false';
  process.env.OTEL_SDK_DISABLED = 'true';
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('offline test forbids network');
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  const core = await import(pathToFileURL(join(ROOT, 'packages/agent-core/dist/index.js')).href);
  // Derive the actual ESM prototype: require.resolve('@google/adk') picks a separate CJS class.
  const instance = core.createGemini('petChat', { projectId: PROJECT, location: REGION });
  const geminiPrototype = Object.getPrototypeOf(Object.getPrototypeOf(instance));
  assert.equal(geminiPrototype.constructor.name, 'Gemini');
  const observed = [];
  t.mock.method(geminiPrototype, 'generateContentAsync', async function* (request) {
    observed.push(request.config);
    yield { content: { role: 'model', parts: [{ text: 'synthetic' }] } };
  });
  const budget = new CallBudget(3, Date.now() + 10_000);
  for (const purpose of ['petChat', 'crisisScreen', 'crisisReview']) {
    const model = boundedModel(core, purpose, budget, new AbortController().signal);
    for await (const value of model.generateContentAsync(
      { config: { maxOutputTokens: 4096, httpOptions: { timeout: 60000 } } },
      false,
    )) {
      assert.ok(value);
    }
  }
  assert.deepEqual(
    observed.map((c) => c.maxOutputTokens),
    [1024, 256, 2048],
  );
  assert.deepEqual(
    observed.map((c) => c.thinkingConfig.thinkingBudget),
    [0, 0, 1024],
  );
  assert.ok(
    observed.every(
      (c) =>
        c.httpOptions.timeout <= LIMITS.transportMs && c.httpOptions.retryOptions.attempts === 1,
    ),
  );
});

test('whitelisted report strips credentials, transcripts, unknown tool names and error strings', () => {
  const safe = sanitizeCase('ordinary', {
    status: 'fail',
    code: SECRET,
    secret: SECRET,
    assertions: { verified_detector: true, [SECRET]: true },
    error: { stack: SECRET },
    toolsSelected: ['remember', SECRET],
    toolsCompleted: [SECRET],
    crisisReasonsSelected: ['violence', SECRET, { category: 'self_harm', text: SECRET }],
    modelCalls: SECRET,
    apiTimings: [{ headersMs: 200, firstDeltaMs: SECRET, completedMs: 400, text: SECRET }],
    petTimings: [{ latencyMs: 120, firstModelEventMs: 30, firstVisibleTextMs: 70, token: SECRET }],
  });
  assert.ok(!JSON.stringify(safe).includes(SECRET));
  assert.equal(safe.code, 'worker_failed');
  assert.deepEqual(safe.toolsSelected, ['remember']);
  assert.deepEqual(safe.crisisReasonsSelected, ['violence']);
  assert.equal(safe.apiTimings[0].firstDeltaMs, null);
  assert.equal(safe.petTimings[0].firstVisibleTextMs, 70);
  assert.equal(
    sanitizeCase('ordinary', { status: 'pass', code: 'verified', modelCalls: 1, transportCalls: 1 })
      .code,
    'incomplete_result',
  );
});

test('model escalation evidence retains only exact reason enums from actual function calls', async () => {
  const { selectedCrisisReasons } = await import('./verify-real-business.mjs');
  assert.equal(typeof selectedCrisisReasons, 'function');
  assert.deepEqual(
    selectedCrisisReasons({
      content: {
        parts: [
          {
            functionCall: {
              name: 'escalate_crisis',
              args: { category: 'violence', evidence: SECRET },
            },
          },
          { functionCall: { name: 'escalate_crisis', args: { category: 'violence' } } },
          { functionCall: { name: 'escalate_crisis', args: { category: SECRET } } },
          { functionCall: { name: 'escalate_crisis', args: { reason: 'extortion' } } },
          { functionCall: { name: 'search_skill', args: { category: 'other', query: SECRET } } },
          { functionResponse: { name: 'escalate_crisis', response: { category: 'self_harm' } } },
          { text: SECRET },
        ],
      },
    }),
    ['violence'],
  );
  for (const value of [undefined, {}, { content: { parts: SECRET } }])
    assert.deepEqual(selectedCrisisReasons(value), []);
  const reasons = ['self_harm', 'violence', 'extortion', 'family_harm', 'other'];
  assert.deepEqual(
    selectedCrisisReasons({
      content: {
        parts: reasons.map((reason) => ({
          functionCall: { name: 'escalate_crisis', args: { category: reason } },
        })),
      },
    }),
    reasons,
  );
});

test('complete business assertions cannot override a latched call-budget failure', () => {
  const budget = new CallBudget(CASES.help.calls, Date.now() + 5000);
  for (let i = 0; i < budget.limit; i++) budget.take('modelCalls');
  assert.throws(() => budget.take('modelCalls'), code('call_budget'));
  const row = sanitizeCase('help', {
    status: 'fail',
    code: budget.failure,
    modelCalls: budget.modelCalls,
    transportCalls: budget.limit,
    assertions: Object.fromEntries(
      [
        'verified_detector',
        'nonfallback_reply',
        'help_api',
        'local_skill_retrieval',
        'model_selected_help',
        'help_action',
        'model_selected_search',
        'model_received_passages',
      ].map((name) => [name, true]),
    ),
  });
  assert.ok(Object.values(row.assertions).every(Boolean));
  assert.equal(row.code, 'call_budget');
  assert.equal(row.exitCode, 1);
});

test('check mode never launches workers and does not claim real coverage', async () => {
  const result = await runVerification(['--check'], env(), {
    preflight: (options, e) => preflight(options, e, io()),
    runCase: () => {
      throw new Error('must not run');
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.status, 'checked');
  assert.equal(result.report.modelCalls, 0);
  assert.equal(result.report.transportCalls, 0);
  assert.ok(
    result.report.cases.every(
      (row) => row.status === 'checked' && row.code === 'configuration_only',
    ),
  );
  assertIsolatedProject(result.report.firestoreProject);
});

test('blocked runs never spawn and redact unstructured preflight errors', async () => {
  const result = await runVerification(
    ['--run'],
    { ...env(), REAL_BUSINESS_APPROVED: '' },
    {
      preflight: (options, e) => preflight(options, e, io()),
      runCase: () => assert.fail('unexpected launch'),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.report.code, 'approval_required');
  const bad = await runVerification(['--run'], env(), {
    preflight: () => {
      throw new Error(SECRET);
    },
  });
  assert.equal(bad.report.code, 'worker_failed');
  assert.ok(!JSON.stringify(bad).includes(SECRET));
});

test('oversubscribed selections are blocked before any worker or preflight even in check mode', async () => {
  for (const mode of ['--run', '--check']) {
    const result = await runVerification([mode, '--case', 'memory,extensions,ordinary'], env(), {
      preflight: () => assert.fail('must reject before preflight'),
      runCase: () => assert.fail('must not partially spend'),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.code, 'call_budget');
    assert.equal(result.report.modelCalls, 0);
    assert.equal(result.report.transportCalls, 0);
  }
});

test('global reservation records full 28-call ceiling even when workers return no usage', async () => {
  const reservations = [];
  const selected = ['memory', 'extensions'];
  const result = await runVerification(['--run', '--case', selected.join(',')], env(), {
    preflight: () => ({ adcPath: '/tmp/synthetic-adc.json' }),
    runCase: async (id) => {
      reservations.push(CASES[id].calls);
      return { status: 'fail', code: 'worker_failed', transcript: SECRET };
    },
  });
  assert.deepEqual(reservations, [18, 10]);
  assert.equal(result.report.plannedCalls, 28);
  assert.equal(result.report.reservedCalls, 28);
  assert.equal(result.report.limits.calls, 30);
  assert.deepEqual(
    result.report.cases.map((row) => row.maxCalls),
    [18, 10],
  );
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('extensions require an explicit judge model and preserve it only through the sanitized env', () => {
  const options = parseArgs(['--run', '--case', 'extensions']);
  assert.throws(() => preflight(options, env(), io()), code('model_required'));
  const configured = { ...env(), GEMINI_MODEL_EVAL_JUDGE: 'gemini-2.5-pro' };
  assert.doesNotThrow(() => preflight(options, configured, io()));
  assert.throws(
    () => preflight(options, { ...configured, GEMINI_MODEL_EVAL_JUDGE: 'gemini-latest' }, io()),
    code('model_required'),
  );
  assert.equal(
    workerEnv(
      { ...configured, GOOGLE_API_KEY: SECRET },
      configured.GOOGLE_APPLICATION_CREDENTIALS,
      PROJECT_ID,
    ).GEMINI_MODEL_EVAL_JUDGE,
    'gemini-2.5-pro',
  );
  assert.ok(
    !JSON.stringify(
      workerEnv(configured, configured.GOOGLE_APPLICATION_CREDENTIALS, PROJECT_ID),
    ).includes(SECRET),
  );
});

test('extensions reports expose only allowlisted booleans and fail without each probe', () => {
  const row = sanitizeCase('extensions', {
    status: 'pass',
    code: 'verified',
    modelCalls: 5,
    transportCalls: 5,
    assertions: { names_redacted: true, [SECRET]: true },
    summary: SECRET,
    names: [SECRET],
    greeting: SECRET,
    judge: { rationale: SECRET },
  });
  assert.equal(row.status, 'fail');
  assert.equal(row.code, 'incomplete_result');
  assert.ok(!JSON.stringify(row).includes(SECRET));
  assert.deepEqual(row.assertions, { names_redacted: true });
});

test('memory cannot pass without every consent, cross-session recall and revocation assertion', () => {
  const assertions = Object.fromEntries(
    [
      'verified_detector',
      'nonfallback_reply',
      'model_selected_remember',
      'pending_encrypted',
      'pending_excluded',
      'consent_saved',
      'memory_encrypted',
      'later_prompt_recall',
      'later_reply_recall',
      'revoked_in_api',
      'revoked_in_executor',
      'revoked_from_model_context',
      'revoked_from_reply',
      'cannot_reaccept',
    ].map((name) => [name, true]),
  );
  const completed = {
    status: 'pass',
    code: 'verified',
    assertions,
    modelCalls: 11,
    transportCalls: 11,
    prompts: [SECRET],
    decryptedMemory: SECRET,
  };
  assert.equal(sanitizeCase('memory', completed).exitCode, 0);
  assert.ok(!JSON.stringify(sanitizeCase('memory', completed)).includes(SECRET));
  for (const name of Object.keys(assertions)) {
    const incomplete = { ...assertions };
    delete incomplete[name];
    assert.equal(
      sanitizeCase('memory', { ...completed, assertions: incomplete }).code,
      'incomplete_result',
    );
  }
  assert.equal(
    sanitizeCase('memory', { ...completed, status: 'fail', code: 'call_budget', modelCalls: 18 })
      .exitCode,
    1,
  );
});

test('supervisor hard-kills a stuck child and preserves completed assertion progress', async () => {
  let options, killed;
  const launch = (_file, _args, opts) => {
    options = opts;
    const child = new EventEmitter();
    child.kill = (signal) => {
      killed = signal;
      queueMicrotask(() => child.emit('close', null));
      return true;
    };
    queueMicrotask(() =>
      child.emit('message', {
        type: 'progress',
        result: {
          status: 'running',
          code: 'running',
          modelCalls: 1,
          transportCalls: 1,
          assertions: { verified_detector: true },
          token: SECRET,
        },
      }),
    );
    return child;
  };
  const result = await runBoundedCase(
    'ordinary',
    env(),
    '/tmp/synthetic-adc.json',
    PROJECT_ID,
    10,
    launch,
  );
  assert.equal(killed, 'SIGKILL');
  assert.equal(result.code, 'deadline');
  assert.equal(result.assertions.verified_detector, true);
  assert.equal(result.modelCalls, 1);
  assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  assert.deepEqual(options.execArgv, []);
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('supervisor refuses successful exit without a complete valid result', async () => {
  const launch = () => {
    const child = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit('message', {
        type: 'result',
        result: { status: 'pass', code: 'verified', text: SECRET },
      });
      child.emit('close', 0);
    });
    return child;
  };
  const result = await runBoundedCase(
    'ordinary',
    env(),
    '/tmp/synthetic-adc.json',
    PROJECT_ID,
    1000,
    launch,
  );
  assert.equal(result.status, 'fail');
  assert.equal(result.exitCode, 1);
});

test('SSE first delta measures API-visible latency, excludes meta/actions and handles split bytes', async () => {
  let now = 100;
  const encoder = new TextEncoder();
  const chunks = [
    'event: meta\ndata: {"messageId":"synthetic"}\n\n',
    'event: action\ndata: {"type":"set_expression"}\n\n',
    'event: del',
    'ta\ndata: {"text":"synthetic"}\n\n',
    'event: done\ndata: {"replyMessageId":"reply"}\n\n',
  ];
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        now += 100;
        if (chunks.length) controller.enqueue(encoder.encode(chunks.shift()));
        else controller.close();
      },
    }),
  );
  const { blocks, timing } = await readSse(response, 0, () => now);
  assert.equal(timing.headersMs, 100);
  assert.ok(timing.firstDeltaMs >= 400);
  assert.ok(timing.completedMs >= timing.firstDeltaMs);
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['meta', 'action', 'delta', 'done'],
  );
});

test('crisis-only SSE has no first text delta and incomplete streams fail closed', async () => {
  const crisis = await readSse(
    new Response('event: crisis\ndata: {"crisisId":"synthetic"}\n\n'),
    Date.now(),
  );
  assert.equal(crisis.timing.firstDeltaMs, null);
  await assert.rejects(
    readSse(new Response('event: delta\ndata: {"text":"partial"}'), Date.now()),
    code('assertion_failed'),
  );
});

test('exported runtime rejects invalid origins and oversized budgets before importing any service', async () => {
  await assert.rejects(
    createRealBusinessRuntime({ allowedOrigins: ['https://remote.test'] }),
    code('invalid_arguments'),
  );
  await assert.rejects(createRealBusinessRuntime({ maxCalls: 31 }), code('call_budget'));
  await assert.rejects(
    createRealBusinessRuntime({ project: PROJECT }),
    code('isolated_project_required'),
  );
});

test('runtime keeps timing config read-only and production publisher/senders isolated', () => {
  const source = readFileSync(FILE, 'utf8');
  assert.ok(!/config\.(agent|crisis|models)[^;\n]*=\s*\d/.test(source));
  assert.ok(!source.includes('new FcmSender('));
  assert.ok(!source.includes('new PubSubRestPublisher('));
  assert.ok(!source.includes('new CloudTasksRestQueue('));
  assert.ok(!source.includes('ScriptedLlm'));
});

test('real preview resolves registered families before synthetic child fixtures', () => {
  const source = readFileSync(FILE, 'utf8');
  assert.ok(source.includes('new core.LocalChildDirectory(db)'));
  assert.ok(!source.includes('new core.DevChildDirectory(db)'));
});
