import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  PROJECT,
  ROOT,
  assertIsolatedProject,
  assertWorkerEnvironment,
  configuration,
  countModelCalls,
  createLocalQueue,
  launchWorker,
  parseArgs,
  preflight,
  startServices,
  workerEnv,
} from './manual-preview.mjs';

const FILE = join(ROOT, 'scripts/manual-preview.mjs');
const SECRET = 'SYNTHETIC_CONTENT_MUST_NOT_ESCAPE';
const env = () => ({
  NODE_ENV: 'test',
  LOCAL_MANUAL_PREVIEW: '1',
  REAL_BUSINESS_APPROVED: '1',
  GCP_PROJECT_ID: PROJECT,
  GCP_REGION: 'asia-northeast1',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8095',
  VOICE_MODEL_MODE: 'disabled',
  GEMINI_MODEL_PET_CHAT: 'gemini-2.5-flash',
  GEMINI_MODEL_CRISIS_SCREEN: 'gemini-2.5-flash',
  GEMINI_MODEL_CRISIS_REVIEW: 'gemini-2.5-flash',
  GEMINI_MODEL_SIGNAL_EXTRACT: 'gemini-2.5-flash',
  GEMINI_MODEL_ARTWORK_FEATURE: 'gemini-2.5-flash',
  GEMINI_MODEL_NOTIFICATION_WRITER: 'gemini-2.5-flash',
  GOOGLE_APPLICATION_CREDENTIALS: '/tmp/manual-synthetic-adc.json',
});

test('import is inert; CLI requires opt-in and never prints inherited content', () => {
  const imported = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `globalThis.fetch = () => { throw Error('network forbidden'); }; await import(${JSON.stringify(pathToFileURL(FILE).href)});`,
    ],
    { env: { GOOGLE_API_KEY: SECRET }, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout + imported.stderr, '');
  const cli = spawnSync(process.execPath, [FILE], {
    env: { ...env(), GOOGLE_API_KEY: SECRET },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(cli.status, 1);
  assert.ok(cli.stdout.includes('requires --run'));
  assert.ok(!(cli.stdout + cli.stderr).includes(SECRET));
  assert.throws(() => parseArgs([]), /opt_in_required/);
  assert.throws(() => parseArgs(['--run', '--relaxed']), /invalid_arguments/);
  parseArgs(['--run']);
});

test('manual configuration rejects production, wrong project, missing flags and nonloopback DB', () => {
  for (const patch of [
    { NODE_ENV: 'production' },
    { LOCAL_MANUAL_PREVIEW: '0' },
    { REAL_BUSINESS_APPROVED: '0' },
    { GCP_PROJECT_ID: 'demo-ijime' },
    { FIRESTORE_EMULATOR_HOST: '0.0.0.0:8095' },
    { FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' },
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:65536' },
    { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8095/path' },
    { VOICE_MODEL_MODE: 'scripted' },
  ])
    assert.throws(() => configuration({ ...env(), ...patch }));
  const config = configuration({ ...env(), NODE_ENV: 'development', GCP_REGION: 'us-central1' });
  assert.equal(config.region, 'us-central1');
  assert.equal(config.voiceEnabled, false);
  assert.deepEqual(config.live, { region: 'us-central1', model: 'gemini-3.8-live' });
  assert.equal(configuration({ ...env(), VOICE_MODEL_MODE: 'vertex' }).voiceEnabled, true);
});

test('worker environment excludes credentials, endpoints, writers, storage, RAG and tracing hooks', () => {
  const unsafe = Object.fromEntries(
    [
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_GENAI_USE_VERTEXAI',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'CALENDAR_OAUTH_REDIRECT_URI',
      'ARTWORKS_BUCKET',
      'KB_BUCKET',
      'KB_LOCAL_DIR',
      'PET_RAG_CORPUS',
      'PET_RAG_SKILL_SOURCES_JSON',
      'BIGQUERY_DATASET',
      'PUBSUB_EMULATOR_HOST',
      'TASKS_INVOKER_SA',
      'NOTIFIER_URL',
      'SELF_URL',
      'NODE_OPTIONS',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'GOOGLE_GEMINI_BASE_URL',
    ].map((key) => [key, SECRET]),
  );
  const clean = workerEnv(
    { ...env(), ...unsafe, LOCAL_PORT_OFFSET: '20', PET_AGENT_URL: SECRET },
    env().GOOGLE_APPLICATION_CREDENTIALS,
  );
  assertWorkerEnvironment(clean);
  for (const key of Object.keys(unsafe)) assert.equal(clean[key], undefined, key);
  assert.equal(clean.PET_AGENT_URL, 'http://127.0.0.1:8102');
  assert.equal(clean.VOICE_MODEL_MODE, 'disabled');
  assert.equal(clean.OTEL_SDK_DISABLED, 'true');
  assert.equal(clean.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS, 'false');
  assert.ok(!JSON.stringify(clean).includes(SECRET));
  assert.throws(
    () => assertWorkerEnvironment({ ...clean, GOOGLE_API_KEY: SECRET }),
    /configuration_changed/,
  );
  assert.throws(
    () => assertWorkerEnvironment({ ...clean, PET_AGENT_URL: 'https://example.test' }),
    /configuration_changed/,
  );
});

test('preflight is file-only and disabled voice does not require voice builds', () => {
  const inspected = [];
  const io = {
    existsSync: (path) => {
      inspected.push(path);
      return true;
    },
    statSync: (path) => ({
      isFile: () => true,
      size: 100,
      mtimeMs: path.includes('/dist/') ? 2 : 1,
    }),
    readdirSync: () => [{ name: 'index.ts', isDirectory: () => false }],
    readFileSync: () =>
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'synthetic',
        client_secret: SECRET,
        refresh_token: SECRET,
      }),
  };
  assert.equal(preflight(env(), io).voiceEnabled, false);
  assert.ok(!inspected.some((path) => path.includes('voice-relay')));
  assert.throws(
    () =>
      preflight(env(), { ...io, readFileSync: () => JSON.stringify({ type: 'external_account' }) }),
    /adc_invalid/,
  );
  assert.throws(
    () =>
      preflight(env(), {
        ...io,
        statSync: () => ({ isFile: () => true, size: 100, mtimeMs: 0 }),
        existsSync: (path) => !path.endsWith('/dist/index.js'),
      }),
    /build_required/,
  );
});

test('fork isolates each database and suppresses all provider output without a new opt-in flag', () => {
  const projects = [];
  for (let n = 0; n < 2; n++)
    launchWorker(env(), env().GOOGLE_APPLICATION_CREDENTIALS, (file, args, options) => {
      assert.equal(file, FILE);
      assert.deepEqual(args, ['--run']);
      assert.deepEqual(options.execArgv, []);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
      assertWorkerEnvironment(options.env);
      return { send: ({ project }) => projects.push(assertIsolatedProject(project)) };
    });
  assert.notEqual(projects[0], projects[1]);
  assert.throws(() => assertIsolatedProject(PROJECT), /isolated_project_required/);
});

test('accounting permits more than 30 model calls, preserves requests and only aborts on shutdown', async () => {
  const counter = { modelCalls: 0 },
    controller = new AbortController();
  const request = { config: { maxOutputTokens: 256, httpOptions: { timeout: 8000 } } };
  const before = structuredClone(request);
  const model = countModelCalls(
    {
      async *generateContentAsync(req, stream, signal) {
        assert.equal(req, request);
        assert.equal(stream, true);
        assert.equal(signal.aborted, false);
        yield { value: 'synthetic' };
      },
    },
    counter,
    controller.signal,
  );
  for (let i = 0; i < 45; i++)
    for await (const _ of model.generateContentAsync(request, true)) {
      /* consume */
    }
  assert.equal(counter.modelCalls, 45);
  assert.deepEqual(request, before);
  controller.abort();
  await assert.rejects(model.generateContentAsync(request, true).next());
  assert.equal(counter.modelCalls, 45);
});

test('event dispatch is asynchronous, retries are finite and successful subscribers are not replayed', async () => {
  let now = 0;
  const attempts = { good: 0, bad: 0 };
  const queue = createLocalQueue({
    schemas: { event: { parse: (v) => ({ id: v.id }) } },
    routes: {
      event: [
        ['good', '/event'],
        ['bad', '/event'],
      ],
    },
    taskRoutes: { send: ['good', '/send'] },
    taskOrigin: 'http://127.0.0.1:8080',
    now: () => now,
    dispatch: async (target) => {
      attempts[target]++;
      if (target === 'bad') throw Error(SECRET);
    },
  });
  await queue.publish('event', { id: 'synthetic' });
  assert.deepEqual(attempts, { good: 0, bad: 0 });
  for (let i = 0; i < 10; i++) {
    await queue.drain();
    now += 10000;
  }
  assert.deepEqual(attempts, { good: 1, bad: 3 });
  assert.deepEqual(queue.status(), { pendingJobs: 0, failedJobs: 1 });
  now = 480001;
  await queue.publish('event', { id: 'later' });
  await queue.drain();
  assert.equal(attempts.good, 2);
  await assert.rejects(
    queue.enqueue({ queue: 'send', url: 'https://cloudtasks.googleapis.com/send', body: {} }),
    /task_invalid/,
  );
  await queue.close();
});

test('disabled voice starts only loopback API and pet services and never attaches a voice server', async () => {
  const ports = [],
    closed = [];
  const app = { fetch() {} };
  const services = await startServices({
    app,
    petApp: app,
    ports: { api: 8080, pet: 8082, voice: 8083 },
    serve: (options) => {
      assert.equal(options.hostname, '127.0.0.1');
      ports.push(options.port);
      const server = new EventEmitter();
      server.closeAllConnections = () => {};
      server.close = () => closed.push(options.port);
      queueMicrotask(() => server.emit('listening'));
      return server;
    },
    attachVoiceServer: () => assert.fail('voice must stay disabled'),
    drain: async () => {},
    close: async () => closed.push('runtime'),
  });
  assert.deepEqual(ports, [8082, 8080]);
  await services.close();
  await services.close();
  assert.deepEqual(closed, [8082, 8080, 'runtime']);
});
