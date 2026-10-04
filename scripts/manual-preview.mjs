import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localPorts } from './local-ports.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = 'zenn-hackathon-510109';
const FILE = fileURLToPath(import.meta.url);
const MODEL_ENV = Object.freeze({
  petChat: 'GEMINI_MODEL_PET_CHAT',
  crisisScreen: 'GEMINI_MODEL_CRISIS_SCREEN',
  crisisReview: 'GEMINI_MODEL_CRISIS_REVIEW',
  signalExtract: 'GEMINI_MODEL_SIGNAL_EXTRACT',
  artworkFeature: 'GEMINI_MODEL_ARTWORK_FEATURE',
  notificationWriter: 'GEMINI_MODEL_NOTIFICATION_WRITER',
});
const BUILDS = [
  'packages/api-types',
  'packages/config',
  'packages/crypto',
  'packages/kb-loader',
  'packages/service-kit',
  'packages/agent-core',
  'packages/crisis-detector',
  'services/api',
  'services/pet-agent',
  'services/signal-worker',
  'services/risk-engine',
  'services/notifier',
  'services/voice-relay',
];
const demand = (ok, code) => {
  if (!ok) throw new Error(code);
};
const modelId = (value) =>
  typeof value === 'string' &&
  value.length <= 100 &&
  /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value) &&
  !/latest|auto|alias/.test(value);
const regionId = (value) => typeof value === 'string' && /^[a-z]+(?:-[a-z]+)+[1-9]$/.test(value);

export function parseArgs(args) {
  demand(args.length > 0, 'opt_in_required');
  demand(args.length === 1 && args[0] === '--run', 'invalid_arguments');
}

export function configuration(env = process.env) {
  demand(['test', 'development'].includes(env.NODE_ENV), 'test_environment_required');
  demand(env.LOCAL_MANUAL_PREVIEW === '1' && env.REAL_BUSINESS_APPROVED === '1', 'opt_in_required');
  demand(env.GCP_PROJECT_ID === PROJECT, 'project_required');
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{3,4})$/.exec(
    env.FIRESTORE_EMULATOR_HOST ?? '',
  );
  demand(match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535, 'emulator_required');
  const region = env.GCP_REGION ?? 'asia-northeast1';
  demand(['vertex', 'disabled'].includes(env.VOICE_MODEL_MODE ?? 'vertex'), 'voice_mode_invalid');
  const voiceEnabled = env.VOICE_MODEL_MODE !== 'disabled';
  const live = {
    region: env.LIVE_REGION ?? 'us-central1',
    model: env.GEMINI_MODEL_PET_VOICE ?? 'gemini-3.8-live',
  };
  demand(regionId(region) && regionId(live.region), 'region_required');
  demand(modelId(live.model), 'model_required');
  const models = Object.fromEntries(
    Object.entries(MODEL_ENV).map(([purpose, key]) => {
      demand(modelId(env[key]), 'model_required');
      return [purpose, env[key]];
    }),
  );
  return {
    region,
    live,
    voiceEnabled,
    models,
    emulator: env.FIRESTORE_EMULATOR_HOST,
    ports: localPorts(env),
  };
}

export function assertIsolatedProject(project) {
  demand(
    /^demo-manual-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      project ?? '',
    ),
    'isolated_project_required',
  );
  return project;
}

// File inspection only: no credential refresh, model calls, probes, or fixture seeding.
export function preflight(
  env = process.env,
  io = { existsSync, readFileSync, readdirSync, statSync },
) {
  const config = configuration(env);
  const adcPath = resolve(
    env.GOOGLE_APPLICATION_CREDENTIALS ||
      join(
        env.CLOUDSDK_CONFIG || join(env.HOME || homedir(), '.config/gcloud'),
        'application_default_credentials.json',
      ),
  );
  demand(io.existsSync(adcPath), 'adc_missing');
  try {
    const stat = io.statSync(adcPath);
    demand(stat.isFile() && stat.size <= 1_048_576, 'adc_invalid');
    const adc = JSON.parse(io.readFileSync(adcPath, 'utf8'));
    const fields =
      adc.type === 'authorized_user'
        ? ['client_id', 'client_secret', 'refresh_token']
        : adc.type === 'service_account'
          ? ['client_email', 'private_key', 'project_id']
          : null;
    demand(
      fields && fields.every((key) => typeof adc[key] === 'string' && adc[key].length > 0),
      'adc_invalid',
    );
    demand(!adc.universe_domain || adc.universe_domain === 'googleapis.com', 'adc_invalid');
    demand(
      !adc.token_uri || adc.token_uri === 'https://oauth2.googleapis.com/token',
      'adc_invalid',
    );
    demand(!adc.service_account_impersonation_url && !adc.credential_source, 'adc_invalid');
    demand(!adc.quota_project_id || adc.quota_project_id === PROJECT, 'adc_invalid');
  } catch {
    throw new Error('adc_invalid');
  }
  for (const unit of BUILDS) {
    if (!config.voiceEnabled && unit === 'services/voice-relay') continue;
    demand(io.existsSync(join(ROOT, unit, 'dist')), 'build_required');
    const inspect = (dir) => {
      for (const entry of io.readdirSync(join(ROOT, unit, 'src', dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name);
        if (entry.isDirectory()) inspect(rel);
        else if (rel.endsWith('.ts') && !/\.(test|d)\.ts$/.test(rel)) {
          const source = join(ROOT, unit, 'src', rel);
          const compiled = join(ROOT, unit, 'dist', rel.replace(/\.ts$/, '.js'));
          demand(
            io.existsSync(compiled) && io.statSync(compiled).mtimeMs >= io.statSync(source).mtimeMs,
            'build_required',
          );
        }
      }
    };
    inspect('');
  }
  demand(io.existsSync(join(ROOT, 'kb/v0.1.0/manifest.json')), 'build_required');
  return { ...config, adcPath };
}

export function workerEnv(env, adcPath) {
  const config = configuration(env);
  const result = {
    NODE_ENV: 'test',
    LOCAL_MANUAL_PREVIEW: '1',
    REAL_BUSINESS_APPROVED: '1',
    GCP_PROJECT_ID: PROJECT,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    GOOGLE_CLOUD_QUOTA_PROJECT: PROJECT,
    GCP_REGION: config.region,
    LIVE_REGION: config.live.region,
    GEMINI_MODEL_PET_VOICE: config.live.model,
    GOOGLE_APPLICATION_CREDENTIALS: resolve(adcPath),
    FIRESTORE_EMULATOR_HOST: config.emulator,
    LOCAL_PORT_OFFSET: String(config.ports.api - 8080),
    PET_AGENT_URL: `http://127.0.0.1:${config.ports.pet}`,
    PET_MODEL_MODE: 'vertex',
    CRISIS_MODEL_MODE: 'vertex',
    VOICE_MODEL_MODE: config.voiceEnabled ? 'vertex' : 'disabled',
    ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false',
    OTEL_SDK_DISABLED: 'true',
  };
  for (const key of ['PATH', 'HOME', 'TMPDIR', ...Object.values(MODEL_ENV)])
    if (env[key] !== undefined) result[key] = env[key];
  return result;
}

export function assertWorkerEnvironment(env, platform = process.platform) {
  demand(typeof env.GOOGLE_APPLICATION_CREDENTIALS === 'string', 'adc_missing');
  const expected = workerEnv(env, env.GOOGLE_APPLICATION_CREDENTIALS);
  const encoding = env.__CF_USER_TEXT_ENCODING;
  const macEncoding =
    platform === 'darwin' &&
    typeof encoding === 'string' &&
    encoding.length <= 64 &&
    /^(?:0x[0-9a-f]+|[0-9]+)(?::(?:0x[0-9a-f]+|[0-9]+)){2}$/i.test(encoding);
  demand(
    Object.keys(env).every(
      (key) => Object.hasOwn(expected, key) || (key === '__CF_USER_TEXT_ENCODING' && macEncoding),
    ) && Object.entries(expected).every(([key, value]) => env[key] === value),
    'configuration_changed',
  );
}

// Wrap only accounting/cancellation. createGemini and the service keep their per-call budgets.
export function countModelCalls(model, counter, signal) {
  if (model.generateContentAsync) {
    const generate = model.generateContentAsync.bind(model);
    model.generateContentAsync = async function* (request, stream, upstream) {
      const combined = AbortSignal.any([signal, upstream].filter(Boolean));
      combined.throwIfAborted();
      counter.modelCalls++;
      yield* generate(request, stream, combined);
    };
  }
  if (model.connect) {
    const connect = model.connect.bind(model);
    model.connect = (...args) => {
      signal.throwIfAborted();
      counter.modelCalls++;
      return connect(...args);
    };
  }
  return model;
}

// Each route has its own retry count, so one failed subscriber never replays successful ones.
export function createLocalQueue({
  schemas,
  routes,
  taskRoutes,
  taskOrigin,
  dispatch,
  now = Date.now,
}) {
  const pending = [],
    taskIds = new Set();
  let running,
    closed = false,
    active = 0,
    failedJobs = 0;
  const add = (jobs) => {
    demand(!closed && pending.length + jobs.length <= 256, 'queue_unavailable');
    pending.push(...jobs);
  };
  return {
    publish: async (topic, payload) => {
      demand(Object.hasOwn(schemas, topic) && Object.hasOwn(routes, topic), 'event_invalid');
      const body = schemas[topic].parse(payload);
      add(
        routes[topic].map(([app, path]) => ({
          app,
          path,
          body,
          event: true,
          attempts: 0,
          due: now(),
        })),
      );
    },
    enqueue: async (spec) => {
      const route = taskRoutes[spec.queue];
      demand(route && spec.url === `${taskOrigin}${route[1]}`, 'task_invalid');
      const delay = spec.delaySeconds ?? 0;
      demand(Number.isFinite(delay) && delay >= 0 && delay <= 86400, 'task_invalid');
      const key = spec.taskId ? `${spec.queue}/${spec.taskId}` : null;
      if (key && taskIds.has(key)) return;
      add([
        {
          app: route[0],
          path: route[1],
          body: structuredClone(spec.body),
          event: false,
          attempts: 0,
          due: now() + delay * 1000,
        },
      ]);
      if (key) {
        taskIds.add(key);
        if (taskIds.size > 4096) taskIds.delete(taskIds.values().next().value);
      }
    },
    drain() {
      if (running) return running;
      if (closed) return Promise.resolve();
      running = (async () => {
        for (let n = 0; n < 32 && !closed; n++) {
          const index = pending.findIndex((job) => job.due <= now());
          if (index < 0) break;
          const [job] = pending.splice(index, 1);
          active = 1;
          try {
            await dispatch(job.app, job.path, job.body, job.event);
          } catch {
            if (++job.attempts < 3 && !closed) {
              job.due = now() + 1000 * 2 ** (job.attempts - 1);
              pending.push(job);
            } else failedJobs++;
          } finally {
            active = 0;
          }
        }
      })().finally(() => {
        running = undefined;
      });
      return running;
    },
    status: () => ({ pendingJobs: pending.length + active, failedJobs }),
    async close() {
      closed = true;
      pending.length = 0;
      taskIds.clear();
      await running;
    },
  };
}

async function loadRuntimeModules({ voiceEnabled }) {
  const paths = {
    core: 'packages/agent-core/dist/index.js',
    crypto: 'packages/crypto/dist/index.js',
    loader: 'packages/kb-loader/dist/index.js',
    safety: 'packages/crisis-detector/dist/index.js',
    kit: 'packages/service-kit/dist/index.js',
    api: 'services/api/dist/app.js',
    apiRuntime: 'services/api/dist/runtime.js',
    images: 'services/api/dist/artwork-io.js',
    client: 'services/api/dist/pet-agent-client.js',
    pet: 'services/pet-agent/dist/app.js',
    petRuntime: 'services/pet-agent/dist/runtime.js',
    signal: 'services/signal-worker/dist/app.js',
    signalRuntime: 'services/signal-worker/dist/runtime.js',
    risk: 'services/risk-engine/dist/app.js',
    riskRuntime: 'services/risk-engine/dist/runtime.js',
    notifier: 'services/notifier/dist/app.js',
    notifierRuntime: 'services/notifier/dist/runtime.js',
    features: 'services/notifier/dist/weekly-source.js',
  };
  if (voiceEnabled)
    Object.assign(paths, {
      voice: 'services/voice-relay/dist/app.js',
      voiceRuntime: 'services/voice-relay/dist/runtime.js',
      backend: 'services/voice-relay/dist/backend.js',
      forwarder: 'services/voice-relay/dist/forwarder.js',
      server: 'services/voice-relay/dist/server.js',
    });
  const modules = Object.fromEntries(
    await Promise.all(
      Object.entries(paths).map(async ([key, path]) => [
        key,
        await import(pathToFileURL(join(ROOT, path)).href),
      ]),
    ),
  );
  const { Firestore } = createRequire(join(ROOT, 'services/api/package.json'))(
    '@google-cloud/firestore',
  );
  const { serve } = createRequire(join(ROOT, 'packages/service-kit/package.json'))(
    '@hono/node-server',
  );
  return { ...modules, Firestore, serve };
}

export async function createManualRuntime(
  { project, env = process.env },
  load = loadRuntimeModules,
) {
  assertIsolatedProject(project);
  assertWorkerEnvironment(env);
  demand(load !== loadRuntimeModules || env === process.env, 'configuration_changed');
  const config = configuration(env);
  const m = await load(config);
  m.core.disableAdkContentCapture();
  const controller = new AbortController(),
    counter = { modelCalls: 0 };
  const db = new m.Firestore({
    projectId: project,
    host: config.emulator,
    ssl: false,
    credentials: { client_email: 'synthetic@invalid.test', private_key: 'unused-emulator-only' },
  });
  let queue;
  try {
    const kb = await m.loader.Kb.load(new m.loader.FsKbSource(join(ROOT, 'kb/v0.1.0')));
    const wrapper = new m.crypto.LocalKeyWrapper(randomBytes(32));
    const directory = new m.core.LocalChildDirectory(db, wrapper);
    const logger = new m.kit.Logger('manual-preview', () => {});
    const shared = { db, kb, directory, logger };
    const model = (purpose) =>
      countModelCalls(
        m.core.createGemini(purpose, {
          projectId: PROJECT,
          location: config.region,
        }),
        counter,
        controller.signal,
      );
    const detector = m.safety.createModelDetector(
      {
        kb,
        screenModel: model('crisisScreen'),
        reviewModel: model('crisisReview'),
      },
      m.safety.KeywordMatcher.fromLexicon(await kb.yaml('lexicon/ja.yaml', m.loader.lexiconSchema)),
    );
    const origins = [config.ports.child, config.ports.guardian].flatMap((port) => [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
    ]);
    const publish = (topic, payload) => queue.publish(topic, payload);
    const tasks = { enqueue: (spec) => queue.enqueue(spec) };
    const taskOrigin = `http://127.0.0.1:${config.ports.api}`;
    const petUrl = `http://127.0.0.1:${config.ports.pet}`;
    const post = async (app, path, body, event = false) => {
      controller.signal.throwIfAborted();
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event ? m.kit.encodePushEnvelope(body) : body),
        signal: controller.signal,
      });
      demand(res.ok, 'local_handler_failed');
    };
    let signalApp;
    const api = await m.apiRuntime.createApiRuntime({
      ...shared,
      detector,
      publish,
      sessions: new m.core.FirestoreSessionService(db, directory),
      petAgent: new m.client.HttpPetAgentClient(petUrl),
      images: new m.images.MemoryArtworkImages(),
      artworkFeatures: (req) => post(signalApp, '/internal/artworks/features', req),
      accounts: {
        cipher: new m.crypto.EnvelopeCipher(wrapper),
        pseudonymizer: new m.crypto.LocalPseudonymizer(randomBytes(32)),
      },
    });
    const prt = await m.petRuntime.createRuntime({
      ...shared,
      publish,
      model: model('petChat'),
      sessions: new m.core.FirestoreSessionService(db, directory, { writeUserEvents: false }),
    });
    const srt = await m.signalRuntime.createRuntime({
      ...shared,
      sessions: api.chat.sessions,
      publisher: { publish },
      model: model('signalExtract'),
      artworkModel: model('artworkFeature'),
    });
    signalApp = m.signal.createApp(async () => srt, logger);
    const rrt = await m.riskRuntime.createRuntime({
      ...shared,
      publisher: { publish },
      tasks,
      notifierUrl: taskOrigin,
    });
    const riskApp = m.risk.createApp(async () => rrt, logger);
    const unavailableSender = {
      send: async () => ({ ok: false, reason: 'no_target', retryable: false }),
    };
    const nrt = await m.notifierRuntime.createRuntime({
      ...shared,
      tasks,
      model: model('notificationWriter'),
      selfUrl: taskOrigin,
      guardianWebOrigin: `http://localhost:${config.ports.guardian}`,
      features: new m.features.MemoryDailyFeatures(),
      senders: { webpush: unavailableSender, email: unavailableSender, sms: unavailableSender },
    });
    const notifierApp = m.notifier.createApp(async () => nrt, logger);
    queue = createLocalQueue({
      schemas: m.kit.eventSchemas,
      taskOrigin,
      dispatch: post,
      routes: {
        'message.created': [[signalApp, '/internal/events/message-created']],
        'artwork.created': [[signalApp, '/internal/events/artwork-created']],
        'checkin.created': [[signalApp, '/internal/events/checkin-created']],
        'signal.extracted': [[riskApp, '/internal/assess']],
        'crisis.detected': [
          [riskApp, '/internal/events/crisis-detected'],
          [notifierApp, '/internal/events/crisis-detected'],
        ],
        'consultation.resolved': [[notifierApp, '/internal/events/consultation-resolved']],
        'risk.level_changed': [],
        'data.deletion_requested': [],
      },
      taskRoutes: {
        'notify-send': [notifierApp, '/internal/tasks/send'],
        'crisis-escalation': [notifierApp, '/internal/tasks/crisis-escalation'],
        'consultation-timeout': [notifierApp, '/internal/tasks/consultation-timeout'],
      },
    });
    let backend, voiceApp;
    if (config.voiceEnabled) {
      const vrt = await m.voiceRuntime.createVoiceRuntime({
        ...shared,
        detector,
        publish,
        callTool: m.forwarder.httpToolCaller(petUrl),
      });
      // Keep the runtime's ResumableGemini factory lazy, including LIVE_REGION and safety gates.
      const createVoiceModel = vrt.createModel;
      vrt.createModel = (...args) => {
        const value = createVoiceModel(...args);
        countModelCalls(value.model, counter, controller.signal);
        return value;
      };
      backend = m.backend.createVoiceBackend(vrt);
      voiceApp = m.voice.createApp(async () => backend);
    }
    const app = m.api.createApp({
      getKb: async () => kb,
      allowedOrigins: origins,
      chat: async () => api.chat,
      submissions: async () => api.submissions,
      guardian: async () => api.guardian,
      accounts: async () => api.accounts,
      voiceWsUrl: `ws://127.0.0.1:${config.ports.voice}/v1/voice`,
    });
    const getStatus = () => ({
      mode: 'real_vertex_manual',
      modelCalls: counter.modelCalls,
      deadline: null,
      maxModelCalls: null,
      live: { ...config.live, enabled: config.voiceEnabled },
      externalDelivery: false,
      retrieval: 'local_versioned_kb',
      ...queue.status(),
    });
    app.get('/local/status', (c) => {
      c.header('Cache-Control', 'no-store');
      return c.json(getStatus());
    });
    return {
      app,
      petApp: m.pet.createApp(async () => prt),
      voiceApp,
      backend,
      logger,
      origins,
      ports: config.ports,
      serve: m.serve,
      attachVoiceServer: m.server?.attachVoiceServer,
      getStatus,
      drain: () => queue.drain(),
      async close() {
        controller.abort();
        await queue.close();
        await db.terminate();
      },
    };
  } catch (error) {
    controller.abort();
    await queue?.close();
    await db.terminate();
    throw error;
  }
}

export async function startServices(runtime) {
  const servers = [];
  let voice, timer, closing;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(timer);
      await voice?.closeAll();
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
      await runtime.close();
    })());
  try {
    const endpoints = [
      [runtime.petApp, runtime.ports.pet],
      [runtime.app, runtime.ports.api],
    ];
    if (runtime.voiceApp) endpoints.push([runtime.voiceApp, runtime.ports.voice]);
    for (const [app, port] of endpoints) {
      const server = runtime.serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
      servers.push(server);
      await new Promise((ok, fail) => {
        server.once('error', fail);
        server.once('listening', () => {
          server.removeListener('error', fail);
          ok();
        });
      });
    }
    if (runtime.voiceApp)
      voice = runtime.attachVoiceServer(servers[2], {
        backend: runtime.backend,
        logger: runtime.logger,
        allowedOrigins: runtime.origins,
      });
    timer = setInterval(() => {
      void runtime.drain().catch(() => {});
    }, 250);
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function launchWorker(env, adcPath, launch = fork) {
  const child = launch(FILE, ['--run'], {
    cwd: ROOT,
    env: workerEnv(env, adcPath),
    execArgv: [],
    // SDK/provider diagnostics can contain content or credentials. Only fixed IPC metadata escapes.
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  child.send({ project: `demo-manual-${randomUUID()}` });
  return child;
}

async function main() {
  parseArgs(process.argv.slice(2));
  if (process.send) {
    assertWorkerEnvironment(process.env);
    preflight();
    process.once('message', (value) => {
      void (async () => {
        const runtime = await createManualRuntime({ project: value?.project });
        const services = await startServices(runtime);
        const stop = () => {
          void services.close().finally(() => process.exit(0));
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        process.once('disconnect', stop);
        process.send?.({ ready: true });
      })().catch(() => process.exit(1));
    });
    return;
  }
  const config = preflight();
  const child = launchWorker(process.env, config.adcPath);
  const stop = (signal) => child.kill(signal);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
  child.on('message', (value) => {
    if (value?.ready === true)
      process.stdout.write(
        `Manual Vertex preview ready: http://127.0.0.1:${config.ports.api}/local/status; no total call/time limit.\n`,
      );
  });
  child.once('error', () => {
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    for (const name of ['SIGINT', 'SIGTERM']) process.removeListener(name, stop);
    process.exitCode = code ?? (['SIGINT', 'SIGTERM'].includes(signal) ? 0 : 1);
    if (process.exitCode)
      process.stdout.write(
        'Manual preview stopped; check ADC, fresh service builds and loopback ports.\n',
      );
  });
}

if (process.argv[1] && resolve(process.argv[1]) === FILE) {
  void main().catch(() => {
    process.stdout.write(
      'Manual preview requires --run, test/development, LOCAL_MANUAL_PREVIEW=1, REAL_BUSINESS_APPROVED=1, the approved project, loopback emulator, explicit models, ADC and fresh builds.\n',
    );
    process.exitCode = 1;
  });
}
