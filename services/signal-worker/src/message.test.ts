import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEvent } from '@google/adk';
import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  PET_APP_NAME,
  ScriptedLlm,
  type Script,
} from '@ijime/agent-core';
import { createNoModelDetector } from '@ijime/crisis-detector';
import { FsKbSource, Kb, lexiconSchema } from '@ijime/kb-loader';
import { encodePushEnvelope, Logger, MemoryPublisher } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { SignalDoc } from './store.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SENTINEL = 'SENTINEL_子どもの言葉';
const EXTRACTED = JSON.stringify({
  signals: [
    {
      signalDefId: 'A-EXCL-003',
      value: 0.9,
      explicit: true,
      contextKind: 'self_report',
      evidence: [{ source: 'current', turnIndex: 0, quote: 'みんなにハブられた' }],
    },
    { signalDefId: 'A-MADEUP-001', value: 1, explicit: true },
  ],
  valence: -0.6,
  topics: ['friends', 'school', 'friends'],
  schoolAvoidance: true,
});

let db: Firestore;
let kb: Kb;
let directory: DevChildDirectory;
let sessions: FirestoreSessionService;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  kb = await Kb.load(new FsKbSource(KB_DIR));
  directory = new DevChildDirectory(db);
  sessions = new FirestoreSessionService(db, directory);
});
afterAll(() => db.terminate());

function setup(script: Script = () => ({ text: EXTRACTED })) {
  const lines: string[] = [];
  const logger = new Logger('signal-worker', (l) => lines.push(l));
  const publisher = new MemoryPublisher();
  const llm = new ScriptedLlm(script, { model: 'scripted-extract' });
  const app = createApp(
    async () => ({
      db,
      kb,
      sessions,
      directory,
      publisher,
      model: llm,
      artworkModel: llm,
      detector: createNoModelDetector(await kb.yaml('lexicon/ja.yaml', lexiconSchema)),
      logger,
      now: () => new Date(),
    }),
    logger,
  );
  const push = (payload: unknown) =>
    app.request('/internal/events/message-created', {
      method: 'POST',
      body: JSON.stringify(encodePushEnvelope(payload)),
      headers: { 'Content-Type': 'application/json' },
    });
  return { lines, publisher, llm, push };
}

async function seedConversation(childId: string) {
  const child = await directory.lookup(childId);
  const session = await sessions.createSession({
    appName: PET_APP_NAME,
    userId: childId,
    state: { channel: 'text' },
  });
  const typing = { keyCount: 40, deleteCount: 10, composeMs: 9000, longPauseCount: 2 };
  const crisisCheck = { hit: false, method: 'keyword', score: 0, checkedAt: new Date() };
  await sessions.writeChildMessage(childId, session.id, {
    text: 'きょう学校いった',
    inputMode: 'typed',
    crisisCheck,
  });
  await new Promise((r) => setTimeout(r, 5));
  await sessions.appendEvent({
    session,
    event: createEvent({
      author: 'pet_agent',
      invocationId: 'i1',
      content: { role: 'model', parts: [{ text: 'どうだった？' }] },
    }),
  });
  const petMsgs = await sessions.readMessages(childId, session.id);
  const petMessageId = petMsgs.find((m) => m.role === 'pet')!.messageId;
  await new Promise((r) => setTimeout(r, 5));
  const { messageId } = await sessions.writeChildMessage(childId, session.id, {
    text: `みんなにハブられた ${SENTINEL}`,
    inputMode: 'typed',
    typing,
    crisisCheck,
  });
  const event = {
    familyId: child.familyId,
    childId,
    sessionId: session.id,
    messageId,
    channel: 'text' as const,
  };
  return { child, event, petMessageId };
}

async function signalsOf(familyId: string, childId: string): Promise<SignalDoc[]> {
  const snap = await db.collection(`families/${familyId}/children/${childId}/signals`).get();
  return snap.docs.map((d) => d.data() as SignalDoc);
}

describe('message.created → signals', () => {
  it('writes rule and model signals, publishes IDs only, and is idempotent', async () => {
    const { child, event } = await seedConversation('c_sw1');
    const t = setup();
    expect((await t.push(event)).status).toBe(204);

    const docs = await signalsOf(child.familyId, 'c_sw1');
    const ids = docs.map((d) => d.signalDefId + (d.metric ? `:${d.metric.name}` : '')).sort();
    expect(ids).toEqual([
      'A-EXCL-003',
      'A-SCHL-001:a_school_avoid',
      'A-TOPIC-001:a_topic_friends',
      'A-TOPIC-001:a_topic_school',
      'A-VAL-001:a_valence',
      'I-HOUR-001:i_message_hour',
      'K-COMP-001:k_compose_ms',
      'K-DEL-001:k_delete_ratio',
      'K-PAUSE-001:k_long_pause_count',
    ]);
    const excl = docs.find((d) => d.signalDefId === 'A-EXCL-003')!;
    expect(excl).toMatchObject({ domain: 'a', value: 0.9, explicit: true, kbVersion: kb.version });
    expect(excl.extractedBy).toContain('prompts/signal_extract.md@');
    expect(excl.sourceRef).toBe(
      `families/${child.familyId}/children/c_sw1/sessions/${event.sessionId}/messages/${event.messageId}`,
    );
    expect(docs.find((d) => d.signalDefId === 'K-DEL-001')).toMatchObject({
      extractedBy: 'rule',
      metric: { name: 'k_delete_ratio', value: 0.25 },
    });
    const allowedKeys = new Set([
      'domain',
      'signalDefId',
      'scoring',
      'value',
      'explicit',
      'sourceRef',
      'kbVersion',
      'extractedBy',
      'localDate',
      'createdAt',
      'expireAt',
      'metric',
      'contextKind',
      'evidenceMatched',
    ]);
    for (const d of docs) for (const k of Object.keys(d)) expect(allowedKeys).toContain(k);

    expect(t.publisher.of('signal.extracted')).toEqual([
      { childId: 'c_sw1', domains: ['a', 'i', 'k'], explicit: true },
    ]);

    const req = JSON.stringify(t.llm.requests[0]);
    expect(req).toContain('A-EXCL-003');
    expect(req).not.toContain('K-DEL-001');
    expect(req).toContain('どうだった？');

    expect((await t.push(event)).status).toBe(204);
    expect(await signalsOf(child.familyId, 'c_sw1')).toHaveLength(docs.length);

    const leaked = [
      t.lines.join('\n'),
      JSON.stringify(t.publisher.published),
      JSON.stringify(docs),
    ];
    for (const s of leaked) expect(s).not.toContain(SENTINEL);
  });

  it('ignores pet messages, deleted sources, and invalid payloads', async () => {
    const { child, event, petMessageId } = await seedConversation('c_sw2');
    const t = setup();
    expect((await t.push({ ...event, messageId: petMessageId })).status).toBe(204);
    expect((await t.push({ ...event, messageId: 'gone' })).status).toBe(204);
    expect((await t.push({ ...event, text: 'x' })).status).toBe(204);
    expect(await signalsOf(child.familyId, 'c_sw2')).toEqual([]);
    expect(t.llm.requests).toHaveLength(0);
    expect(t.publisher.published).toEqual([]);
  });

  it('keeps rule signals and asks for a retry when extraction fails', async () => {
    const { child, event } = await seedConversation('c_sw3');
    const t = setup(() => ({ text: 'not json' }));
    expect((await t.push(event)).status).toBe(503);
    const docs = await signalsOf(child.familyId, 'c_sw3');
    expect(docs.every((d) => d.extractedBy === 'rule')).toBe(true);
    expect(docs.map((d) => d.domain).sort()).toEqual(['i', 'k', 'k', 'k']);
    expect(t.publisher.published).toEqual([]);
  });

  it('skips typing signals when the child turned typing off', async () => {
    const { child, event } = await seedConversation('c_sw4');
    await db
      .doc(`families/${child.familyId}/children/c_sw4`)
      .update({ 'dataSources.typing': false });
    const t = setup();
    expect((await t.push(event)).status).toBe(204);
    const docs = await signalsOf(child.familyId, 'c_sw4');
    expect(docs.some((d) => d.domain === 'k')).toBe(false);
  });

  it.each([
    ['legacy', {}],
    [
      'fiction',
      {
        contextKind: 'fiction',
        evidence: [{ source: 'current', turnIndex: 0, quote: 'みんなにハブられた' }],
      },
    ],
    [
      'quotation',
      {
        contextKind: 'quotation',
        evidence: [{ source: 'current', turnIndex: 0, quote: 'みんなにハブられた' }],
      },
    ],
    [
      'ungrounded',
      {
        contextKind: 'self_report',
        evidence: [{ source: 'current', turnIndex: 0, quote: '言っていないこと' }],
      },
    ],
    [
      'pet',
      {
        contextKind: 'self_report',
        evidence: [
          { source: 'current', turnIndex: 0, quote: 'みんなにハブられた' },
          { source: 'prior', turnIndex: 1, quote: 'どうだった？' },
        ],
      },
    ],
  ])(
    'replays %s output without publishing explicit risk or losing other signals',
    async (id, extra) => {
      const childId = `c_sw_evidence_${id}`;
      const { child, event } = await seedConversation(childId);
      const t = setup(() => ({
        text: JSON.stringify({
          ...JSON.parse(EXTRACTED),
          signals: [{ signalDefId: 'A-EXCL-003', value: 0.9, explicit: true, ...extra }],
        }),
      }));
      expect((await t.push(event)).status).toBe(204);
      expect((await t.push(event)).status).toBe(204);
      const docs = await signalsOf(child.familyId, childId);
      expect(docs).toHaveLength(9);
      expect(docs.find((d) => d.signalDefId === 'A-EXCL-003')?.explicit).toBe(false);
      expect(docs.every((d) => !d.explicit)).toBe(true);
      expect(t.publisher.of('signal.extracted').every((e) => !e.explicit)).toBe(true);
      expect(JSON.stringify([docs, t.publisher.published, t.lines])).not.toContain(SENTINEL);
      expect(JSON.stringify(docs)).not.toContain('quote');
    },
  );
});
