import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { DevChildDirectory } from '@ijime/agent-core';
import { CrisisDetector, KeywordMatcher } from '@ijime/crisis-detector';
import type { ChildHomeRes, ChoiceRes, ConsultationRes, FollowupsRes } from '@ijime/api-types';
import { FsKbSource, Kb, storyRequestsSchema } from '@ijime/kb-loader';
import { Logger } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { ChatDeps } from './chat.js';
import { createApiRuntime } from './runtime.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
const SOURCES = {
  voice: true,
  typing: false,
  artwork_save: false,
  home_checkin: true,
  calendar: false,
};
const SECRET = '星を見るのが好き';
let db: Firestore;
let deps: ChatDeps;
let directory: DevChildDirectory;
let app: ReturnType<typeof createApp>;
const events: { topic: string; payload: Record<string, unknown> }[] = [];
const logs: string[] = [];
let kb: Kb;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime' });
  directory = new DevChildDirectory(db);
  kb = await Kb.load(new FsKbSource(KB_DIR));
  const runtime = await createApiRuntime({
    db,
    directory,
    kb,
    auth: { allowDevHeader: true },
    logger: new Logger('workflow', (line) => logs.push(line)),
    publish: async (topic, payload) => {
      events.push({ topic, payload });
    },
  });
  deps = runtime.chat;
  app = createApp({ getKb: async () => kb, allowedOrigins: [], chat: async () => deps });
});
afterAll(async () => {
  await db?.terminate();
});

async function owner() {
  const childId = `wf_${randomUUID().replaceAll('-', '')}`;
  const child = await directory.lookup(childId);
  const base = `families/${child!.familyId}/children/${childId}`;
  return { childId, child: child!, base };
}

function request(
  childId: string,
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/v1/child${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Dev-Child-Id': childId, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function propose(
  o: Awaited<ReturnType<typeof owner>>,
  id: string,
  extra: Record<string, unknown> = {},
) {
  await db.doc(`${o.base}/memoryProposals/${id}`).set({
    contentEnc: deps.sessions.encryptForChild(
      o.child,
      SECRET,
      `${o.base}/memoryProposals#contentEnc`,
    ),
    category: 'like',
    status: 'pending',
    characterId: o.child.characterId,
    petId: o.child.petId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...extra,
  });
}

describe('child profile workflows on Firestore', () => {
  it('authenticates and returns only child-facing home fields, including a pending consultation', async () => {
    expect((await app.request('/v1/child/home')).status).toBe(401);
    const o = await owner();
    await db
      .doc(`${o.base}/consultations/c1`)
      .set({ level: 'l3', offeredAt: new Date(), offerCount: 1 });
    await db.doc(`${o.base}/moodCheckins/m1`).set({
      weather: 'cloudy',
      localDate: new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10),
      createdAt: new Date(),
    });
    const response = await request(o.childId, '/home');
    expect(response.status).toBe(200);
    const body = (await response.json()) as ChildHomeRes;
    expect(body).toMatchObject({
      gradeBand: 'high',
      pet: { characterId: 'moko' },
      todayMood: 'cloudy',
      pendingConsultation: { consultationId: 'c1' },
    });
    expect(JSON.stringify(body)).not.toMatch(/currentRiskLevel|"level"|wrappedDek|careFlag/);
  });

  it('persists preferences and validates all data-source switches', async () => {
    const o = await owner();
    expect(
      (
        await request(o.childId, '/preferences', 'PUT', {
          gradeBand: 'low',
          nickname: 'ほし',
          ttsEnabled: true,
        })
      ).status,
    ).toBe(200);
    expect(await (await request(o.childId, '/preferences')).json()).toEqual({
      gradeBand: 'low',
      nickname: 'ほし',
      ttsEnabled: true,
    });
    expect((await request(o.childId, '/preferences', 'PUT', { gradeBand: 'adult' })).status).toBe(
      400,
    );
    expect(
      (await request(o.childId, '/data-sources', 'PUT', { dataSources: SOURCES })).status,
    ).toBe(200);
    expect(await (await request(o.childId, '/data-sources')).json()).toEqual({
      dataSources: SOURCES,
    });
    expect(
      (await request(o.childId, '/data-sources', 'PUT', { dataSources: { voice: false } })).status,
    ).toBe(400);
    expect(
      (await request(o.childId, '/data-sources', 'PUT', { dataSources: SOURCES, childId: 'other' }))
        .status,
    ).toBe(400);
  });

  it('records child assent separately, without fabricating guardian consent', async () => {
    const o = await owner();
    const res = await request(o.childId, '/assent', 'POST', {
      documentVersion: 'v0.1.0',
      dataSources: SOURCES,
    });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { consentId: string }).consentId;
    const consent = (await db.doc(`families/${o.child.familyId}/consents/${id}`).get()).data()!;
    expect(consent).toMatchObject({ type: 'child_assent', subjectChildId: o.childId });
    expect(consent['verificationMethod']).toBeUndefined();
    expect((await db.doc(o.base).get()).get('assentComplete')).toBe(true);
  });

  it('changes pets, explicitly carries memories, and rejects foreign pet IDs', async () => {
    const o = await owner();
    const foreign = await owner();
    await db.doc(`${o.base}/memories/m1`).set({
      contentEnc: deps.sessions.encryptForChild(o.child, SECRET, `${o.base}/memories#contentEnc`),
      createdAt: new Date(),
      category: 'like',
    });
    await db.doc(`${foreign.base}/pets/foreign-only`).set({ characterId: 'nami', active: false });
    expect(
      (
        await request(o.childId, '/pets', 'POST', {
          characterId: 'nami',
          carryMemoryFrom: 'foreign-only',
        })
      ).status,
    ).toBe(404);
    const res = await request(
      o.childId,
      '/pets',
      'POST',
      { characterId: 'nami', carryMemoryFrom: o.child.petId },
      { 'Idempotency-Key': 'pet1' },
    );
    expect(res.status).toBe(201);
    const pet = (await res.json()) as { petId: string };
    expect((await db.doc(`${o.base}/memories/m1`).get()).data()).toMatchObject({
      petId: pet.petId,
      characterId: 'nami',
    });
    expect((await request(o.childId, '/home')).status).toBe(200);
    expect(
      ((await (await request(o.childId, '/home')).json()) as ChildHomeRes).pet.characterId,
    ).toBe('nami');
    expect(
      await (
        await request(
          o.childId,
          '/pets',
          'POST',
          { characterId: 'nami', carryMemoryFrom: o.child.petId },
          { 'Idempotency-Key': 'pet1' },
        )
      ).json(),
    ).toEqual(
      await (
        await request(
          o.childId,
          '/pets',
          'POST',
          { characterId: 'nami', carryMemoryFrom: o.child.petId },
          { 'Idempotency-Key': 'pet1' },
        )
      ).json(),
    );
    expect((await db.collection(`${o.base}/pets`).where('active', '==', true).get()).size).toBe(1);
  });
});

describe('authorized memory lifecycle', () => {
  it('only saves after acceptance, re-encrypts with memory AAD, and is idempotent', async () => {
    const o = await owner();
    await propose(o, 'p1');
    expect(await (await request(o.childId, '/memories')).json()).toEqual({ items: [] });
    expect(await (await request(o.childId, '/memory-proposals')).json()).toMatchObject({
      items: [{ proposalId: 'p1', text: SECRET }],
    });
    const first = await request(o.childId, '/memory-proposals/p1/decision', 'POST', {
      decision: 'accept',
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'saved', memoryId: 'p1' });
    const saved = (await db.doc(`${o.base}/memories/p1`).get()).data()!;
    expect(Buffer.from(saved['contentEnc']).toString()).not.toContain(SECRET);
    expect(
      deps.sessions.decryptForChild(o.child, saved['contentEnc'], `${o.base}/memories#contentEnc`),
    ).toBe(SECRET);
    expect((await db.doc(`${o.base}/memoryProposals/p1`).get()).get('contentEnc')).toBeUndefined();
    expect(
      await (
        await request(o.childId, '/memory-proposals/p1/decision', 'POST', { decision: 'accept' })
      ).json(),
    ).toEqual({ status: 'saved', memoryId: 'p1' });
    expect((await db.collection(`${o.base}/memories`).get()).size).toBe(1);
    expect(await (await request(o.childId, '/memories')).json()).toMatchObject({
      items: [{ memoryId: 'p1', text: SECRET }],
    });
  });

  it('rejects expired proposals and makes rejection terminal', async () => {
    const o = await owner();
    await propose(o, 'expired', { expiresAt: new Date(0) });
    expect(
      (
        await request(o.childId, '/memory-proposals/expired/decision', 'POST', {
          decision: 'accept',
        })
      ).status,
    ).toBe(400);
    await propose(o, 'rejected');
    expect(
      await (
        await request(o.childId, '/memory-proposals/rejected/decision', 'POST', {
          decision: 'reject',
        })
      ).json(),
    ).toEqual({ status: 'rejected' });
    expect(
      (
        await request(o.childId, '/memory-proposals/rejected/decision', 'POST', {
          decision: 'accept',
        })
      ).status,
    ).toBe(409);
    expect(
      (await db.doc(`${o.base}/memoryProposals/rejected`).get()).get('contentEnc'),
    ).toBeUndefined();
  });

  it('isolates children and rejects proposals belonging to a previous pet', async () => {
    const o = await owner();
    const other = await owner();
    await propose(o, 'private');
    expect(
      (
        await request(other.childId, '/memory-proposals/private/decision', 'POST', {
          decision: 'accept',
        })
      ).status,
    ).toBe(404);
    await propose(o, 'old-pet', { petId: 'old' });
    expect(
      (
        await request(o.childId, '/memory-proposals/old-pet/decision', 'POST', {
          decision: 'accept',
        })
      ).status,
    ).toBe(400);
  });

  it('deletes memory content and derived summary without allowing a stale confirmation to restore it', async () => {
    const o = await owner();
    await propose(o, 'gone');
    await request(o.childId, '/memory-proposals/gone/decision', 'POST', { decision: 'accept' });
    await db.doc(o.base).update({ agentSummary: { text: SECRET, approved: true } });
    expect((await request(o.childId, '/memories/gone', 'DELETE')).status).toBe(204);
    expect((await db.doc(`${o.base}/memories/gone`).get()).exists).toBe(false);
    expect((await db.doc(o.base).get()).get('agentSummary')).toBeUndefined();
    expect((await db.doc(o.base).get()).get('modelHistoryResetAt')).toBeDefined();
    expect(
      (await request(o.childId, '/memory-proposals/gone/decision', 'POST', { decision: 'accept' }))
        .status,
    ).toBe(409);
    expect((await request(o.childId, '/memories/gone', 'DELETE')).status).toBe(204);
  });
});

describe('consultation and follow-up workflows', () => {
  it('creates a consultation, binds all reads to the current child, and returns no risk level', async () => {
    const o = await owner();
    const other = await owner();
    const res = await request(o.childId, '/tell-adult', 'POST', {});
    expect(res.status).toBe(201);
    const { consultationId } = (await res.json()) as { consultationId: string };
    const duplicate = await request(o.childId, '/tell-adult', 'POST', {});
    expect(await duplicate.json()).toEqual({ consultationId });
    const details = (await (
      await request(o.childId, `/consultations/${consultationId}`)
    ).json()) as ConsultationRes;
    expect(details).toMatchObject({
      consultationId,
      status: 'pending',
      choices: ['self', 'proxy', 'not_now'],
      notificationQueued: false,
    });
    expect(details).not.toHaveProperty('level');
    expect((await request(other.childId, `/consultations/${consultationId}`)).status).toBe(404);
    expect(
      (
        await request(other.childId, `/consultations/${consultationId}/choice`, 'POST', {
          choice: 'self',
        })
      ).status,
    ).toBe(404);
  });

  it('reopens a due not-now consultation and preserves the offer limit', async () => {
    const o = await owner();
    await db.doc(`${o.base}/consultations/due`).set({
      level: 'l2',
      choice: 'not_now',
      offeredAt: new Date(),
      offerCount: 1,
      followUpAt: new Date(0),
    });
    expect(
      ((await (await request(o.childId, '/home')).json()) as ChildHomeRes).pendingConsultation,
    ).toEqual({ consultationId: 'due' });
    expect(
      (await request(o.childId, '/consultations/due/choice', 'POST', { choice: 'self' })).status,
    ).toBe(200);
    expect((await db.doc(`${o.base}/consultations/due`).get()).get('offerCount')).toBe(2);
    expect(
      ((await (await request(o.childId, '/home')).json()) as ChildHomeRes).pendingConsultation,
    ).toBeUndefined();
  });

  it('reads and answers due followups with a single help consultation and no automatic dispatch', async () => {
    const o = await owner();
    await db.doc(`${o.base}/consultations/due`).set({
      level: 'l2',
      choice: 'not_now',
      offeredAt: new Date(),
      offerCount: 1,
      followUpAt: new Date(0),
    });
    const due = (await (await request(o.childId, '/followups')).json()) as FollowupsRes;
    expect(due.items).toMatchObject([{ followupId: 'consultation-due', kind: 'consultation' }]);
    const before = events.length;
    const response = await request(o.childId, '/followups/consultation-due/answer', 'POST', {
      answer: 'need_help',
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'answered', consultationId: expect.any(String) });
    expect(
      await (
        await request(o.childId, '/followups/consultation-due/answer', 'POST', {
          answer: 'need_help',
        })
      ).json(),
    ).toEqual(body);
    expect(
      (await request(o.childId, '/followups/consultation-due/answer', 'POST', { answer: 'talked' }))
        .status,
    ).toBe(409);
    expect(await (await request(o.childId, '/followups')).json()).toEqual({ items: [] });
    expect(events.length).toBe(before);
  });

  it('offers next-day crisis followup but never closes a crisis just because the child answered', async () => {
    const o = await owner();
    await db
      .doc(`${o.base}/crisisEvents/k1`)
      .set({ status: 'open', createdAt: new Date(Date.now() - 2 * 86_400_000) });
    const due = (await (await request(o.childId, '/followups')).json()) as FollowupsRes;
    expect(due.items).toMatchObject([{ followupId: 'crisis-k1', kind: 'crisis' }]);
    expect(
      (await request(o.childId, '/followups/crisis-k1/answer', 'POST', { answer: 'talked' }))
        .status,
    ).toBe(200);
    expect((await db.doc(`${o.base}/crisisEvents/k1`).get()).get('status')).toBe('open');
    expect(await (await request(o.childId, '/followups')).json()).toEqual({ items: [] });
  });

  it('returns a crisis payload for a dangerous summary and reuses the crisis ID on retry', async () => {
    const o = await owner();
    await db
      .doc(`${o.base}/consultations/c1`)
      .set({ level: 'l2', offeredAt: new Date(), offerCount: 1 });
    const body = { choice: 'proxy', summary: { text: 'もう消えたい', confirmed: true } };
    const first = await request(o.childId, '/consultations/c1/choice', 'POST', body);
    expect(first.status).toBe(200);
    const crisis = (await first.json()) as ChoiceRes;
    expect(crisis).toMatchObject({
      crisis: {
        crisisId: expect.any(String),
        message: expect.any(String),
        resources: expect.any(Array),
      },
    });
    expect(
      await (await request(o.childId, '/consultations/c1/choice', 'POST', body)).json(),
    ).toEqual({ ...crisis, notificationQueued: false });
    expect((await db.collection(`${o.base}/crisisEvents`).get()).size).toBe(1);
  });
});

describe('story prompt workflow', () => {
  it('requires authentication and chooses a KB prompt for the child grade band', async () => {
    expect((await app.request('/v1/child/games/story-prompt')).status).toBe(401);
    const { prompts } = await kb.yaml('games/story_prompts.yaml', storyRequestsSchema);
    const day = Math.floor((Date.now() + 9 * 3_600_000) / 86_400_000);
    const expected = (band: 'low' | 'jhs') => {
      const available = prompts.filter((p) => p.grade_bands.includes(band));
      const prompt = available[day % available.length]!;
      return { promptId: prompt.id, text: prompt.text_ja };
    };
    const o = await owner();
    await request(o.childId, '/preferences', 'PUT', { gradeBand: 'low' });
    const low = await request(o.childId, '/games/story-prompt');
    expect(low.status).toBe(200);
    expect(await low.json()).toEqual(expected('low'));
    expect(expected('low').promptId).not.toBe(expected('jhs').promptId);
    await request(o.childId, '/preferences', 'PUT', { gradeBand: 'jhs' });
    expect(await (await request(o.childId, '/games/story-prompt')).json()).toEqual(expected('jhs'));
  });
});

describe('active crisis overrides ordinary help workflows', () => {
  it('rechecks safety after summary review and refuses a newly unsafe disclosure', async () => {
    const o = await owner();
    await db
      .doc(`${o.base}/consultations/old`)
      .set({ level: 'l3', offeredAt: new Date(), offerCount: 1 });
    const detector = new CrisisDetector(
      new KeywordMatcher(['消えたい']),
      {
        screen: async () => {
          await db
            .doc(`${o.base}/crisisEvents/during-review`)
            .set({ status: 'open', familyHarmSuspected: true, createdAt: new Date() });
          return { suspect: false };
        },
      },
      {
        review: async () => {
          throw new Error('not expected');
        },
      },
    );
    const guarded = createApp({
      getKb: async () => Kb.load(new FsKbSource(KB_DIR)),
      allowedOrigins: [],
      chat: async () => ({ ...deps, detector }),
    });
    const before = events.length;
    const response = await guarded.request('/v1/child/consultations/old/choice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-Child-Id': o.childId },
      body: JSON.stringify({ choice: 'proxy', summary: { text: SECRET, confirmed: true } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      notificationQueued: false,
      crisis: { crisisId: 'during-review' },
    });
    expect((await db.doc(`${o.base}/consultations/old`).get()).get('choice')).toBeUndefined();
    expect(events.length).toBe(before);
  });

  it('persists unavailable detector evidence and does not claim a parent notification', async () => {
    const o = await owner();
    await db
      .doc(`${o.base}/consultations/c1`)
      .set({ level: 'l2', offeredAt: new Date(), offerCount: 1 });
    const detector = new CrisisDetector(
      new KeywordMatcher(['消えたい']),
      { screen: async () => ({ suspect: true }) },
      {
        review: async () => {
          throw new Error('test outage');
        },
      },
    );
    const guarded = createApp({
      getKb: async () => Kb.load(new FsKbSource(KB_DIR)),
      allowedOrigins: [],
      chat: async () => ({ ...deps, detector }),
    });
    const response = await guarded.request('/v1/child/consultations/c1/choice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dev-Child-Id': o.childId },
      body: JSON.stringify({ choice: 'proxy', summary: { text: 'もう消えたい', confirmed: true } }),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ChoiceRes;
    expect(result.notificationQueued).toBe(false);
    expect(result.crisis).toBeDefined();
    const event = await db.doc(`${o.base}/crisisEvents/${result.crisis!.crisisId}`).get();
    expect(event.get('detection')).toMatchObject({
      availability: 'unavailable',
      method: 'review_timeout',
    });
    expect(event.get('familyHarmSuspected')).toBe(true);
  });

  it.each([true, undefined])(
    'blocks new requests and every old choice when family safety is %s',
    async (familyHarmSuspected) => {
      const o = await owner();
      await db
        .doc(`${o.base}/consultations/old`)
        .set({ level: 'l3', offeredAt: new Date(), offerCount: 1 });
      await db.doc(`${o.base}/crisisEvents/current`).set({
        status: 'open',
        createdAt: new Date(),
        ...(familyHarmSuspected === undefined ? {} : { familyHarmSuspected }),
      });
      const before = events.length;
      const tell = await request(o.childId, '/tell-adult', 'POST', {});
      expect(tell.status).toBe(200);
      const result = await tell.json();
      expect(result).toMatchObject({
        crisis: { crisisId: 'current', resources: [{ id: 'jidou_soudan' }, { id: 'emergency' }] },
      });
      expect(result).not.toHaveProperty('consultationId');
      for (const choice of ['self', 'proxy', 'not_now']) {
        const answer = await request(o.childId, '/consultations/old/choice', 'POST', {
          choice,
          ...(choice === 'proxy' ? { summary: { text: SECRET, confirmed: true } } : {}),
        });
        expect(answer.status).toBe(200);
        expect(await answer.json()).toMatchObject({
          notificationQueued: false,
          crisis: { crisisId: 'current' },
        });
      }
      const details = await (await request(o.childId, '/consultations/old')).json();
      expect(details).toMatchObject({
        notificationQueued: false,
        choices: [],
        crisis: { crisisId: 'current' },
      });
      expect((await db.collection(`${o.base}/consultations`).get()).size).toBe(1);
      expect((await db.doc(`${o.base}/consultations/old`).get()).get('choice')).toBeUndefined();
      expect((await db.collection(`families/${o.child.familyId}/notifications`).get()).empty).toBe(
        true,
      );
      expect(events.length).toBe(before);
    },
  );

  it('prioritizes unresolved family-harm records even after guardian acknowledgement', async () => {
    const o = await owner();
    await db
      .doc(`${o.base}/crisisEvents/a-safe`)
      .set({ status: 'open', familyHarmSuspected: false, createdAt: new Date() });
    await db
      .doc(`${o.base}/crisisEvents/z-unsafe`)
      .set({ status: 'guardian_acknowledged', familyHarmSuspected: true, createdAt: new Date() });
    expect(await (await request(o.childId, '/tell-adult', 'POST', {})).json()).toMatchObject({
      crisis: { crisisId: 'z-unsafe' },
    });
  });
});

describe('production child access policy', () => {
  it('requires assent before protected routes while keeping safety resources available', async () => {
    const o = await owner();
    const prod = createApp({
      getKb: async () => Kb.load(new FsKbSource(KB_DIR)),
      allowedOrigins: [],
      chat: async () => ({
        ...deps,
        auth: {
          allowDevHeader: false,
          verifyIdToken: async () => ({ sub: 'uid', role: 'child', childId: o.childId }),
        },
      }),
    });
    const headers = {
      Authorization: 'Bearer verified-fixture',
      'Content-Type': 'application/json',
    };
    for (const path of ['home', 'memories', 'data-sources', 'followups', 'games/story-prompt']) {
      const res = await prod.request(`/v1/child/${path}`, { headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: { code: 'ASSENT_REQUIRED' } });
    }
    expect((await prod.request('/v1/child/help-resources')).status).toBe(200);
    expect(
      (
        await prod.request('/v1/child/assent', {
          method: 'POST',
          headers,
          body: JSON.stringify({ documentVersion: 'v0.1.0', dataSources: SOURCES }),
        })
      ).status,
    ).toBe(201);
    expect((await prod.request('/v1/child/home', { headers })).status).toBe(200);
    await db.doc(o.base).update({ status: 'paused' });
    expect((await prod.request('/v1/child/home', { headers })).status).toBe(403);
    expect((await prod.request('/v1/child/help-resources')).status).toBe(200);
  });
});

describe('deletion workflow', () => {
  it('removes online content and notifications, keeps a tombstone, and does not pretend external deletion finished', async () => {
    const o = await owner();
    await propose(o, 'p1');
    await db
      .doc(`${o.base}/sessions/s1/messages/m1`)
      .set({ contentEnc: Buffer.from('encrypted fixture') });
    await db
      .doc(`families/${o.child.familyId}/notifications/n1`)
      .set({ childId: o.childId, payload: { childSummary: SECRET } });
    const deleted = await request(o.childId, '/data-deletion-requests', 'POST', {});
    expect(deleted.status).toBe(202);
    const body = (await deleted.json()) as { requestId: string; status: string };
    expect(body.status).toBe('accepted');
    expect((await db.doc(o.base).get()).get('status')).toBe('deleting');
    expect((await db.collection(`${o.base}/memoryProposals`).get()).empty).toBe(true);
    expect((await db.doc(`${o.base}/sessions/s1/messages/m1`).get()).exists).toBe(false);
    expect((await db.doc(`families/${o.child.familyId}/notifications/n1`).get()).exists).toBe(
      false,
    );
    const home = await request(o.childId, '/home');
    expect([403, 404]).toContain(home.status);
    expect((await db.doc(o.base).get()).get('status')).toBe('deleting');
    const record = (await db.doc(`deletionRequests/${body.requestId}`).get()).data()!;
    expect(record['status']).toBe('accepted');
    expect(record['firestoreClearedAt']).toBeDefined();
    expect(record['completedAt']).toBeUndefined();
    expect(events.at(-1)).toEqual({
      topic: 'data.deletion_requested',
      payload: { familyId: o.child.familyId, childId: o.childId, scope: 'child' },
    });
  });

  it('does not leak memory content in logs or event payloads', () => {
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});
