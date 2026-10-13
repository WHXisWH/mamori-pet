import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore, type DocumentReference } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  petDemoScript,
  ScriptedLlm,
} from '@ijime/agent-core';
import { createApp as createApiApp } from '@ijime/api/src/app.js';
import { AppPetAgentClient } from '@ijime/api/src/pet-agent-client.js';
import { createApiRuntime } from '@ijime/api/src/runtime.js';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { createApp as createPetApp } from '@ijime/pet-agent/src/app.js';
import { createRuntime as createPetRuntime } from '@ijime/pet-agent/src/runtime.js';
import { createApp as createRiskApp } from '@ijime/risk-engine/src/app.js';
import { createRuntime as createRiskRuntime } from '@ijime/risk-engine/src/runtime.js';
import { MemoryExternalChildData } from '@ijime/risk-engine/src/deletion.js';
import {
  encodePushEnvelope,
  Logger,
  MemoryTaskQueue,
  type ServiceApp,
  type TaskSpec,
} from '@ijime/service-kit';
import { createApp as createSignalApp } from '@ijime/signal-worker/src/app.js';
import { createRuntime as createSignalRuntime } from '@ijime/signal-worker/src/runtime.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { MemorySender } from './channels.js';
import { createRuntime } from './runtime.js';
import { MemoryDailyFeatures } from './weekly-source.js';

// 経路全体のカナリア（保護者側 API は原文を返さない、原文は暗号化して保存する、ログやイベントに子どもの入力を出さない）：
// 一意な文字列を子どもの入力として api → pet-agent → signal-worker → risk-engine → notifier まで通し、
// 出口側から確かめる。ログ、Pub/Sub、Cloud Tasks、保護者に送るメッセージ、保護者側 API、Firestore に保存されたデータのどこにも現れてはならない。
// サービスごとのログの確認で示せるのは「そのサービスが出力しなかった」ことだけで、ここでは「経路全体のどの出口からも漏れていない」ことを示す。

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const NONCE = randomBytes(6).toString('hex');
// カタカナも16進数も正規化、大文字・小文字の変換、書き換えを受けうるため、スキャンでは16進数の部分だけを大文字・小文字を区別せずに探す
const CANARY = `カナリア${NONCE}`;
const NEEDLE = new RegExp(NONCE, 'i');
// ID にカナリアを含めてはならない。含めるとパスやイベントの ID が漏れと誤判定される
const ID = randomBytes(4).toString('hex');
const CHILD = `c_canary_${ID}`;
const GUARDIAN = `g_canary_${ID}`;
const DISCLOSURE = `今日、学校でみんなに無視されてつらい ${CANARY}`;

let db: Firestore;
let family: string;
let api: ServiceApp;
const logLines: string[] = [];
const published: { topic: string; payload: unknown }[] = [];
const tasks = new MemoryTaskQueue();
const executedTasks: TaskSpec[] = [];
const webpush = new MemorySender();
const email = new MemorySender();
const sms = new MemorySender();
let notifier: ServiceApp;
let signal: ServiceApp;
let risk: ServiceApp;

const childHeaders = { 'Content-Type': 'application/json', 'X-Dev-Child-Id': CHILD };
const guardianHeaders = { 'Content-Type': 'application/json', 'X-Dev-Guardian-Id': GUARDIAN };

async function push(app: ServiceApp, path: string, payload: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    body: JSON.stringify(encodePushEnvelope(payload)),
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status, path).toBeLessThan(300);
}

// Pub/Sub の購読関係に従って、イベントを同期的に下流へ送る（scripts/local-backend.mjs と同じ）
async function publish(topic: string, payload: unknown) {
  published.push({ topic, payload });
  const routes: Record<string, [ServiceApp, string][]> = {
    'message.created': [[signal, '/internal/events/message-created']],
    'signal.extracted': [[risk, '/internal/assess']],
    'consultation.resolved': [[notifier, '/internal/events/consultation-resolved']],
    'crisis.detected': [
      [risk, '/internal/events/crisis-detected'],
      [notifier, '/internal/events/crisis-detected'],
    ],
  };
  for (const [app, path] of routes[topic] ?? []) await push(app, path, payload);
}

// キューに入った通知の送信タスクを notifier に実行させ、メモリ上のチャネルに送る
async function drainNotifierTasks() {
  for (let round = 0; round < 5 && tasks.tasks.length > 0; round++) {
    for (const task of tasks.tasks.splice(0)) {
      executedTasks.push(task);
      const path = new URL(task.url).pathname;
      if (!path.startsWith('/internal/')) continue;
      await notifier.request(path, {
        method: 'POST',
        body: JSON.stringify(task.body),
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  const kb = await Kb.load(new FsKbSource(KB_DIR));
  const directory = new DevChildDirectory(db);
  const sink = (line: string) => void logLines.push(line);
  const logger = (name: string) => new Logger(name, sink);

  const child = await directory.lookup(CHILD);
  family = child.familyId;
  await db.doc(`families/${family}/guardians/${GUARDIAN}`).set({
    guardianId: GUARDIAN,
    role: 'primary',
    email: 'canary@example.com',
    notifyChannels: ['webpush', 'email'],
  });
  await db.doc(`families/${family}/devices/d_canary`).set({
    ownerType: 'guardian',
    ownerId: GUARDIAN,
    fcmToken: 'tok-canary',
    lastSeenAt: new Date(),
  });

  const petRuntime = await createPetRuntime({
    kb,
    db,
    directory,
    sessions: new FirestoreSessionService(db, directory, { writeUserEvents: false }),
    model: new ScriptedLlm(petDemoScript()),
    logger: logger('pet-agent'),
    publish,
  });
  const rt = await createApiRuntime({
    kb,
    db,
    directory,
    petAgent: new AppPetAgentClient(createPetApp(async () => petRuntime) as never),
    logger: logger('api'),
    publish,
    auth: { allowDevHeader: true },
  });
  api = createApiApp({
    getKb: async () => kb,
    allowedOrigins: [],
    chat: async () => rt.chat,
    guardian: async () => rt.guardian,
  });

  // 最悪のケース：抽出モデルが子どもの言葉を文ごとそのまま evidence に写す
  const extractor = new ScriptedLlm(
    ({ lastUserText }) => {
      const explicit = lastUserText.includes(DISCLOSURE);
      return {
        text: JSON.stringify({
          signals: explicit
            ? [
                {
                  signalDefId: 'A-EXCL-003',
                  value: 0.9,
                  explicit: true,
                  contextKind: 'self_report',
                  evidence: [{ source: 'current', turnIndex: 0, quote: DISCLOSURE }],
                },
              ]
            : [],
          valence: explicit ? -0.6 : 0,
          topics: explicit ? ['school'] : ['other'],
          schoolAvoidance: false,
        }),
      };
    },
    { model: 'scripted-extractor' },
  );
  const srt = await createSignalRuntime({
    kb,
    db,
    directory,
    sessions: rt.chat.sessions,
    publisher: { publish } as never,
    model: extractor,
    artworkModel: new ScriptedLlm(() => ({ text: '{}' }), { model: 'scripted-artwork' }),
    logger: logger('signal-worker'),
  });
  signal = createSignalApp(async () => srt, logger('signal-worker'));
  const rrt = await createRiskRuntime({
    kb,
    db,
    publisher: { publish } as never,
    tasks,
    logger: logger('risk-engine'),
    notifierUrl: 'http://notifier.test',
    external: new MemoryExternalChildData(),
  });
  risk = createRiskApp(async () => rrt, logger('risk-engine'));
  const nrt = await createRuntime({
    kb,
    db,
    tasks,
    logger: logger('notifier'),
    selfUrl: 'http://notifier.test',
    // 最悪のケース：通知文を作るモデルが、受け取ったものを何でも通知に書こうとする
    model: new ScriptedLlm(
      ({ lastUserText }) => ({
        text: JSON.stringify({
          title: '最近の様子について',
          changes: ['会話の様子に、いつもと違う傾向が見られました'],
          meaning: 'ゆっくり話せる時間をつくってみてください',
          suggestions: { try: ['声をかける'], avoid: ['問い詰める'] },
          echo: lastUserText,
        }),
      }),
      { model: 'scripted-writer' },
    ),
    senders: { webpush, email, sms },
    features: new MemoryDailyFeatures(),
    guardianWebOrigin: 'http://guardian.test',
  });
  notifier = createApp(async () => nrt, logger('notifier'));
});

afterAll(() => db?.terminate());

async function say(sessionId: string, text: string) {
  const res = await api.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: childHeaders,
    body: JSON.stringify({ text, inputMode: 'typed', clientSentAt: new Date().toISOString() }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

async function startSession() {
  const res = await api.request('/v1/child/chat/sessions', {
    method: 'POST',
    headers: childHeaders,
    body: '{}',
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { sessionId: string }).sessionId;
}

// Firestore にある1家庭のすべてのドキュメント（サブコレクションを含む）。Bytes は UTF-8 として展開し、平文で書き込まれていても見つかるようにする
async function dumpTree(ref: DocumentReference, out: string[] = []): Promise<string[]> {
  const snap = await ref.get();
  if (snap.exists) {
    out.push(
      `${ref.path} ${JSON.stringify(snap.data(), (_k, v) =>
        v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)
          ? Buffer.from(v.data).toString('utf8')
          : v,
      )}`,
    );
  }
  for (const col of await ref.listCollections()) {
    for (const doc of await col.listDocuments()) await dumpTree(doc, out);
  }
  return out;
}

function leaks(label: string, haystack: string[]) {
  return haystack.filter((s) => NEEDLE.test(s)).map((s) => `${label}: ${s.slice(0, 200)}`);
}

describe('privacy canary across the whole chain', () => {
  let guardianBodies: string[] = [];

  it('drives ordinary talk, an explicit disclosure and a crisis through every service', async () => {
    const sessionId = await startSession();
    const childStream = [
      await say(sessionId, `きょうは ${CANARY} のことを話したい`),
      await say(sessionId, DISCLOSURE),
    ];

    // 明確な発言 → risk-engine が相談を始める。子どもが「今は言わない」を選ぶ → 保護者には内容を含まないお知らせだけが届く
    const consults = await db
      .collection(`families/${family}/children/${CHILD}/consultations`)
      .get();
    expect(consults.size, 'the disclosure should reach risk-engine and open a consultation').toBe(
      1,
    );
    const choice = await api.request(`/v1/child/consultations/${consults.docs[0]!.id}/choice`, {
      method: 'POST',
      headers: childHeaders,
      body: JSON.stringify({ choice: 'not_now' }),
    });
    expect(choice.status).toBe(200);

    // 危機：キーワードとカナリアを入れ、セーフモードと危機通知の経路を通す
    const crisisSession = await startSession();
    childStream.push(await say(crisisSession, `もう消えたい ${CANARY}`));
    await drainNotifierTasks();

    // 陽性対照：カナリアが実際に各区間を通ったことを確かめる。そうでなければ「漏れていない」に意味がない
    const topics = published.map((p) => p.topic);
    expect(topics).toEqual(
      expect.arrayContaining([
        'message.created',
        'signal.extracted',
        'consultation.resolved',
        'crisis.detected',
      ]),
    );
    const notifications = await db.collection(`families/${family}/notifications`).get();
    expect(notifications.docs.map((d) => d.get('kind'))).toEqual(
      expect.arrayContaining(['content_free_alert', 'crisis']),
    );
    expect(webpush.sent.length + email.sent.length).toBeGreaterThan(0);
    // 子ども本人は当然、自分の言葉を見られる。読み戻しの経路で実際に原文が復号されていることを確かめる
    const history = await api.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
      headers: childHeaders,
    });
    expect(await history.text()).toMatch(NEEDLE);
    expect(childStream.join('')).not.toMatch(NEEDLE);

    // 保護者側：保護者が使える読み取り API を1つずつ呼ぶ
    const paths = [
      '/v1/me',
      '/v1/consents',
      '/v1/notifications',
      '/v1/guardians/me/notify-settings',
      `/v1/children/${CHILD}/weekly-reports`,
      ...notifications.docs.map((d) => `/v1/notifications/${d.id}`),
    ];
    guardianBodies = [];
    let okCount = 0;
    for (const path of paths) {
      const res = await api.request(path, { headers: guardianHeaders });
      if (res.ok) okCount += 1;
      guardianBodies.push(`${path} ${res.status} ${await res.text()}`);
    }
    expect(okCount, guardianBodies.join('\n')).toBeGreaterThanOrEqual(2);
  });

  it('the canary never appears in logs', () => {
    expect(logLines.length).toBeGreaterThan(0);
    expect(leaks('log', logLines)).toEqual([]);
  });

  it('the canary never appears in Pub/Sub events or Cloud Tasks payloads', () => {
    expect(
      leaks(
        'pubsub',
        published.map((p) => `${p.topic} ${JSON.stringify(p.payload)}`),
      ),
    ).toEqual([]);
    expect(
      leaks(
        'task',
        executedTasks.map((t) => `${t.queue} ${t.url} ${JSON.stringify(t.body)}`),
      ),
    ).toEqual([]);
  });

  it('the canary never reaches a guardian, by push, email, SMS or API', () => {
    expect(
      leaks(
        'outbound',
        [...webpush.sent, ...email.sent, ...sms.sent].map((s) => JSON.stringify(s)),
      ),
    ).toEqual([]);
    expect(leaks('guardian-api', guardianBodies)).toEqual([]);
  });

  it('the canary is never stored in plaintext anywhere in the family tree', async () => {
    const docs = await dumpTree(db.doc(`families/${family}`));
    expect(docs.some((d) => d.includes('/messages/'))).toBe(true);
    expect(leaks('firestore', docs)).toEqual([]);
  });
});
