import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  petDemoScript,
  ScriptedLlm,
} from '@ijime/agent-core';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { createApp as createPetAgentApp } from '@ijime/pet-agent/src/app.js';
import { createRuntime as createPetRuntime } from '@ijime/pet-agent/src/runtime.js';
import { Logger, type CrisisRedeliveryTask } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { AppPetAgentClient } from './pet-agent-client.js';
import { createApiRuntime } from './runtime.js';

// 危機イベントの発行に問題があるとき（2026-10-12 決定）：子どもには変わらずすぐ相談窓口が案内され、保護者への通知は黙って失われずに再送に回る
const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');

let db: Firestore;
let kb: Kb;
beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  kb = await Kb.load(new FsKbSource(KB_DIR));
});
afterAll(() => db.terminate());

async function harness(crisisPublish: () => Promise<void>) {
  const directory = new DevChildDirectory(db);
  const lines: string[] = [];
  const redelivered: CrisisRedeliveryTask[] = [];
  const pet = await createPetRuntime({
    kb,
    db,
    directory,
    sessions: new FirestoreSessionService(db, directory, { writeUserEvents: false }),
    model: new ScriptedLlm(petDemoScript()),
    logger: new Logger('pet-agent', () => {}),
  });
  const rt = await createApiRuntime({
    kb,
    db,
    directory,
    petAgent: new AppPetAgentClient(createPetAgentApp(async () => pet) as never),
    logger: new Logger('api', (l) => void lines.push(l)),
    publish: async (topic) => {
      if (topic === 'crisis.detected') await crisisPublish();
    },
    requestCrisisRedelivery: async (task) => void redelivered.push(task),
    auth: { allowDevHeader: true },
  });
  const app = createApp({ getKb: async () => kb, allowedOrigins: [], chat: async () => rt.chat });
  const headers = {
    'Content-Type': 'application/json',
    'X-Dev-Child-Id': `c_pub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
  const start = await app.request('/v1/child/chat/sessions', {
    method: 'POST',
    headers,
    body: '{}',
  });
  const { sessionId } = (await start.json()) as { sessionId: string };
  const events = () => lines.map((l) => JSON.parse(l).event as string);
  // crisis イベントを読んだらすぐ返し、ストリーム全体の終了は待たない。子どもが相談窓口の案内を受け取るまでの時間を測る
  async function sayCrisis() {
    const started = Date.now();
    const res = await app.request(`/v1/child/chat/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text: 'もう消えたい',
        inputMode: 'typed',
        clientSentAt: new Date().toISOString(),
      }),
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!/event: crisis\ndata: .+\n/.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const crisisMs = Date.now() - started;
    while (!(await reader.read()).done);
    return { text, crisisMs };
  }
  return { sayCrisis, redelivered, events };
}

describe('crisis publication failures', () => {
  it('Pub/Sub down: the child still gets hotlines and the event is queued for redelivery', async () => {
    const h = await harness(async () => {
      throw new Error('pubsub down');
    });
    const { text } = await h.sayCrisis();
    expect(text).toContain('event: crisis');
    expect(text).toContain('sos_dial');
    expect(h.redelivered).toHaveLength(1);
    expect(h.redelivered[0]).toMatchObject({ familyHarmSuspected: false });
    expect(h.events()).toEqual(
      expect.arrayContaining(['crisis.publish_failed', 'crisis.redelivery_queued']),
    );
  });

  it('Pub/Sub hanging: hotlines reach the child without waiting for the publish', async () => {
    const h = await harness(() => new Promise<void>(() => {}));
    const { text, crisisMs } = await h.sayCrisis();
    expect(text).toContain('event: crisis');
    expect(crisisMs).toBeLessThan(1000);
    expect(h.redelivered).toHaveLength(1);
  }, 20_000);

  it('Pub/Sub healthy: published once, nothing queued', async () => {
    const h = await harness(async () => {});
    const { text } = await h.sayCrisis();
    expect(text).toContain('event: crisis');
    expect(h.redelivered).toEqual([]);
    expect(h.events()).not.toContain('crisis.publish_failed');
  });
});
