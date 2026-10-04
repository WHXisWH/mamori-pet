import { createRequire } from 'node:module';
import { localPorts } from './local-ports.mjs';
import { ScriptedLlm } from '../packages/agent-core/dist/index.js';
import { encodePushEnvelope, Logger } from '../packages/service-kit/dist/index.js';
import { createApp as apiApp } from '../services/api/dist/app.js';
import { createApiRuntime } from '../services/api/dist/runtime.js';
import { createApp as petApp } from '../services/pet-agent/dist/app.js';
import { createRuntime as petRuntime } from '../services/pet-agent/dist/runtime.js';
import { createApp as signalApp } from '../services/signal-worker/dist/app.js';
import { createRuntime as signalRuntime } from '../services/signal-worker/dist/runtime.js';
import { createApp as riskApp } from '../services/risk-engine/dist/app.js';
import { createRuntime as riskRuntime } from '../services/risk-engine/dist/runtime.js';
import { createApp as notifierApp } from '../services/notifier/dist/app.js';
import { createRuntime as notifierRuntime } from '../services/notifier/dist/runtime.js';
import { MemoryDailyFeatures } from '../services/notifier/dist/weekly-source.js';
import { previousWeek, runWeeklyReport } from '../services/notifier/dist/weekly.js';
import { moodScoresSchema } from '../packages/kb-loader/dist/index.js';
import { createApp as voiceApp } from '../services/voice-relay/dist/app.js';
import { createVoiceBackend } from '../services/voice-relay/dist/backend.js';
import { createVoiceRuntime } from '../services/voice-relay/dist/runtime.js';
import { attachVoiceServer } from '../services/voice-relay/dist/server.js';

// Deliberately emulator-only, loopback-only, and deterministic. This is not an AI evaluation.
if (
  process.env.NODE_ENV === 'production' ||
  !/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')
) {
  throw new Error(
    'Local backend requires a loopback Firestore emulator and non-production NODE_ENV',
  );
}
if (process.env.GCP_PROJECT_ID && process.env.GCP_PROJECT_ID !== 'demo-ijime') {
  throw new Error('Local backend only permits project demo-ijime');
}
process.env.GCP_PROJECT_ID = 'demo-ijime';
process.env.PET_MODEL_MODE = 'scripted';
process.env.CRISIS_MODEL_MODE = 'scripted';
// Explicitly disable cloud voice even if a shell happens to export its opt-in.
process.env.VOICE_MODEL_MODE = 'disabled';
const ports = localPorts();
process.env.PET_AGENT_URL = `http://localhost:${ports.pet}`;
const require = createRequire(new URL('../packages/service-kit/package.json', import.meta.url));
const { serve } = require('@hono/node-server');
const logger = new Logger('local-backend');
const origins = [
  `http://localhost:${ports.child}`,
  `http://localhost:${ports.guardian}`,
  `http://127.0.0.1:${ports.child}`,
  `http://127.0.0.1:${ports.guardian}`,
];
const servers = [];
const timers = new Set();
const taskIds = new Set();
const eventCounts = {};
let notifier;
let signal;
let risk;
let lastFailure = null;
async function post(app, path, body) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    lastFailure = { path, status: res.status };
    throw new Error(`local handler ${path}: ${res.status}`);
  }
}
const tasks = {
  async enqueue(spec) {
    const key = spec.taskId ? `${spec.queue}/${spec.taskId}` : null;
    if (key && taskIds.has(key)) return;
    if (key) taskIds.add(key);
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        void post(notifier, new URL(spec.url).pathname, spec.body).catch(() =>
          logger.error('local.task_failed', { queue: spec.queue }),
        );
      },
      (spec.delaySeconds ?? 0) * 1000,
    );
    timers.add(timer);
    timer.unref();
  },
};
const publish = async (topic, payload) => {
  eventCounts[topic] = (eventCounts[topic] ?? 0) + 1;
  const envelope = encodePushEnvelope(payload);
  const paths = {
    'message.created': [signal, '/internal/events/message-created'],
    'artwork.created': [signal, '/internal/events/artwork-created'],
    'checkin.created': [signal, '/internal/events/checkin-created'],
    'signal.extracted': [risk, '/internal/assess'],
    'consultation.resolved': [notifier, '/internal/events/consultation-resolved'],
  };
  if (topic === 'crisis.detected') {
    await post(risk, '/internal/events/crisis-detected', envelope);
    await post(notifier, '/internal/events/crisis-detected', envelope);
  } else if (paths[topic]) await post(...paths[topic], envelope);
};
const api = await createApiRuntime({
  publish,
  artworkFeatures: (req) => post(signal, '/internal/artworks/features', req),
});
const shared = { db: api.chat.db, kb: api.kb, directory: api.chat.directory, logger };
const child = await shared.directory.lookup('c_dev');
const demoFamily = shared.db.doc(`families/${child.familyId}`);
if (!(await demoFamily.get()).exists)
  await demoFamily.create({
    familyId: child.familyId,
    primaryGuardianId: 'g_dev',
    status: 'active',
    termsVersion: 'local-demo-v1',
    consentComplete: true,
    developmentOnly: true,
  });
for (const type of ['guardian_terms', 'guardian_sensitive']) {
  const ref = shared.db.doc(`families/${child.familyId}/consents/local-demo-${type}`);
  if (!(await ref.get()).exists)
    await ref.create({
      type,
      actorId: 'g_dev',
      documentVersion: 'local-demo-v1',
      verificationMethod: 'local_demo_unverified',
      grantedAt: new Date(),
    });
}
const demoGuardian = shared.db.doc(`families/${child.familyId}/guardians/g_dev`);
if (!(await demoGuardian.get()).exists)
  await demoGuardian.create({
    guardianId: 'g_dev',
    role: 'primary',
    email: '',
    displayName: '体験用の保護者',
    notifyChannels: ['webpush'],
  });

// Only this exact synthetic sentence emits an explicit demo signal.
const demoDisclosure = '今日、学校でみんなに無視されてつらい';
const extractor = new ScriptedLlm(
  ({ lastUserText }) => {
    const explicit = lastUserText.includes(demoDisclosure);
    return {
      text: JSON.stringify({
        signals: explicit
          ? [
              {
                signalDefId: 'A-EXCL-003',
                value: 0.9,
                explicit: true,
                contextKind: 'self_report',
                evidence: [{ source: 'current', turnIndex: 0, quote: demoDisclosure }],
              },
            ]
          : [],
        valence: explicit ? -0.6 : 0,
        topics: explicit ? ['school'] : ['other'],
        schoolAvoidance: false,
      }),
    };
  },
  { model: 'scripted-local-extractor' },
);
const artwork = new ScriptedLlm(
  () => ({
    text: JSON.stringify({
      selfPresent: false,
      othersCount: 0,
      explicitHarm: false,
      storyOutcome: 'unclear',
      contextKind: 'uncertain',
      evidence: [],
    }),
  }),
  { model: 'scripted-local-artwork' },
);
const writer = new ScriptedLlm(
  () => ({
    text: JSON.stringify({
      title: 'お子さんからの相談',
      changes: [],
      meaning: 'まずは落ち着いて、お子さんの話を聞く時間をつくってください。',
      suggestions: {
        try: ['話してくれたことに感謝する', '本人の希望を聞く'],
        avoid: ['問い詰める'],
      },
    }),
  }),
  { model: 'scripted-local-writer' },
);
const unavailableSender = {
  send: async () => ({ ok: false, reason: 'no_target', retryable: false }),
};
const srt = await signalRuntime({
  ...shared,
  sessions: api.chat.sessions,
  publisher: { publish },
  model: extractor,
  artworkModel: artwork,
});
signal = signalApp(async () => srt, logger);
const rrt = await riskRuntime({ ...shared, publisher: { publish }, tasks });
risk = riskApp(async () => rrt, logger);
const nrt = await notifierRuntime({
  ...shared,
  model: writer,
  tasks,
  senders: { webpush: unavailableSender, email: unavailableSender, sms: unavailableSender },
  guardianWebOrigin: `http://localhost:${ports.guardian}`,
  features: new MemoryDailyFeatures(),
});
notifier = notifierApp(async () => nrt, logger);
// Only the built-in synthetic child has seeded history. New families start empty.
const demoProfile = await shared.db
  .doc(`families/${child.familyId}/children/${child.childId}`)
  .get();
const { weekStart } = previousWeek(new Date());
const { scores } = await api.kb.yaml('rules/mood_scores.yaml', moodScoresSchema);
const demoWeather = ['sunny', 'cloudy', 'sunny', 'rainy', 'cloudy'];
for (const [day, weather] of demoWeather.entries()) {
  nrt.features.rows.push({
    pseudo_id: demoProfile.get('pseudoId'),
    feature_date: new Date(Date.parse(`${weekStart}T00:00:00Z`) + day * 86400000)
      .toISOString()
      .slice(0, 10),
    domain: 'm',
    feature_name: 'm_mood_mean',
    value: scores[weather],
  });
}
await runWeeklyReport(nrt, { weekStart });
const prt = await petRuntime({ ...shared, publish });
const app = apiApp({
  getKb: async () => api.kb,
  allowedOrigins: origins,
  chat: async () => api.chat,
  submissions: async () => api.submissions,
  guardian: async () => api.guardian,
  accounts: async () => api.accounts,
  ...(api.calendar ? { calendar: async () => api.calendar } : {}),
  voiceWsUrl: `ws://localhost:${ports.voice}/v1/voice`,
});
app.get('/local/status', (c) =>
  c.json({
    mode: 'scripted',
    realModelVerified: false,
    externalDelivery: false,
    eventCounts,
    lastFailure,
  }),
);
const listen = (app, port) => {
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
  servers.push(server);
  return server;
};
listen(
  petApp(async () => prt),
  ports.pet,
);
listen(app, ports.api);
const vrt = await createVoiceRuntime({ ...shared, detector: api.chat.detector, publish });
const backend = createVoiceBackend(vrt);
const voiceServer = listen(
  voiceApp(async () => backend),
  ports.voice,
);
const voice = attachVoiceServer(voiceServer, { backend, logger, allowedOrigins: origins });
logger.info('local.ready', {
  apiPort: ports.api,
  petPort: ports.pet,
  voicePort: ports.voice,
  mode: 'scripted',
  externalDelivery: false,
});
async function stop() {
  await voice.closeAll();
  for (const timer of timers) clearTimeout(timer);
  for (const server of servers) server.close();
  await shared.db.terminate();
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
