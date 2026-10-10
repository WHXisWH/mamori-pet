import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FieldValue, Firestore } from '@google-cloud/firestore';
import { DevChildDirectory, PET_APP_NAME, ScriptedLlm, type ChildRecord } from '@ijime/agent-core';
import type { ProactiveTurnReq } from '@ijime/api-types';
import { agent } from '@ijime/config';
import { FsKbSource, Kb, openingsSchema, safeRepliesSchema } from '@ijime/kb-loader';
import { ApiHttpError, Logger } from '@ijime/service-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { generateProactiveGreeting, runProactiveTurn } from './proactive.js';
import { createRuntime, type PetRuntime } from './runtime.js';

const DAY = new Date('2026-10-06T03:00:00Z');
const NIGHT = new Date('2026-10-06T14:00:00Z');
const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
let kb: Kb;
beforeAll(async () => {
  kb = await Kb.load(new FsKbSource(KB_DIR));
});
afterEach(() => vi.restoreAllMocks());

describe('proactive validation and fixed replies without Firestore', () => {
  it.each([
    { childId: '../child', localDate: '2026-10-06', slot: 'morning' },
    { childId: 'child', localDate: '2026-02-30', slot: 'morning' },
    { childId: 'child', localDate: '2026-13-06', slot: 'morning' },
    { childId: 'child', localDate: '2026-1-6', slot: 'morning' },
    { childId: 'child', localDate: '2026-10-06', slot: 'unknown' },
  ])('rejects invalid task before accessing runtime: %j', async (task) => {
    await expect(
      runProactiveTurn({} as PetRuntime, task as ProactiveTurnReq, () => DAY),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 });
  });

  it.each(['low', 'high', 'jhs'] as const)(
    'uses the fixed night KB reply for %s',
    async (gradeBand) => {
      const executorFor = vi.fn();
      const rt = { kb, executorFor } as unknown as PetRuntime;
      const child = { childId: 'unit', gradeBand } as ChildRecord;
      const { replies } = await kb.yaml('prompts/rest-reminders.yaml', safeRepliesSchema);
      expect(await generateProactiveGreeting(rt, child, 'night', 'bedtime', () => NIGHT)).toEqual({
        greeting: { text: replies[gradeBand], expression: 'caring' },
        fallback: true,
      });
      expect(executorFor).not.toHaveBeenCalled();
    },
  );

  it('does not start a model after its lease has already expired', async () => {
    const executorFor = vi.fn();
    const rt = { kb, executorFor } as unknown as PetRuntime;
    const child = { childId: 'unit', gradeBand: 'low' } as ChildRecord;
    const { openings } = await kb.yaml('prompts/openings.yaml', openingsSchema);
    expect(
      await generateProactiveGreeting(rt, child, 'expired', 'morning', () => DAY, DAY),
    ).toEqual({ greeting: { text: openings.low[0], expression: 'caring' }, fallback: true });
    expect(executorFor).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env['FIRESTORE_EMULATOR_HOST'])(
  'proactive transactional execution',
  () => {
    let db: Firestore;
    beforeAll(() => {
      db = new Firestore({ projectId: `demo-proactive-${process.pid}-${Date.now().toString(36)}` });
    });
    afterAll(async () => {
      await db?.terminate();
    });

    async function setup(label: string, model = new ScriptedLlm(() => ({ text: 'Hello.' }))) {
      const logLines: string[] = [];
      const rt = await createRuntime({
        db,
        kb,
        directory: new DevChildDirectory(db),
        model,
        logger: new Logger('proactive-test', (line) => logLines.push(line)),
      });
      const task: ProactiveTurnReq = {
        childId: `c_${label}`,
        localDate: '2026-10-06',
        slot: 'morning',
      };
      const child = (await rt.directory.lookup(task.childId))!;
      const base = `families/${child.familyId}/children/${child.childId}`;
      const receipt = db.doc(`${base}/proactiveTurns/${task.localDate}-${task.slot}`);
      const usage = db.doc(`${base}/chatUsage/${task.localDate}_proactive`);
      const sessionId = `proactive-${task.localDate}-${task.slot}`;
      const sessionRef = db.doc(`${base}/sessions/${sessionId}`);
      return { rt, model, child, task, base, receipt, usage, sessionId, sessionRef, logLines };
    }

    function holdModel(model: ScriptedLlm) {
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = model.generateContentAsync.bind(model);
      const calls = vi
        .spyOn(model, 'generateContentAsync')
        .mockImplementation(async function* (request, stream) {
          enter();
          await released;
          yield* original(request, stream);
        });
      return { entered, release, calls };
    }

    async function revokeContext(base: string, state: 'revision' | 'history' | 'pet') {
      await db.doc(base).update({
        agentSummary: FieldValue.delete(),
        ...(state === 'revision' ? { memoryRevision: FieldValue.increment(1) } : {}),
        ...(state === 'history' ? { modelHistoryResetAt: new Date() } : {}),
        ...(state === 'pet' ? { activePetId: 'another-pet' } : {}),
      });
    }

    it.each(['revision', 'history', 'pet'] as const)(
      'discards an in-flight greeting after the %s context is revoked',
      async (state) => {
        const revoked = '以前の 好きな絵の 話を しよう。';
        const f = await setup(`revoke_${state}`, new ScriptedLlm(() => ({ text: revoked })));
        await db.doc(f.base).update({
          agentSummary: {
            textEnc: f.rt.sessions.encryptForChild(
              f.child,
              revoked,
              `${f.base}#agentSummary.textEnc`,
            ),
            approved: true,
            petId: f.child.petId,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
        const send = vi.fn();
        f.rt.childPush = { send };
        const gate = holdModel(f.model);
        const first = runProactiveTurn(f.rt, f.task, () => DAY);
        try {
          await Promise.race([
            gate.entered,
            first.then(() => {
              throw new Error('model did not start');
            }),
          ]);
          await revokeContext(f.base, state);
        } finally {
          gate.release();
        }
        const result = await first;
        expect(JSON.stringify(f.model.requests)).toContain(revoked);
        expect(result.fallback).toBe(true);
        expect(JSON.stringify(result)).not.toContain(revoked);
        expect(JSON.stringify((await f.receipt.get()).data())).not.toContain(revoked);
        expect(await runProactiveTurn(f.rt, f.task, () => DAY)).toEqual(result);
        expect(gate.calls).toHaveBeenCalledTimes(1);
        expect((await f.usage.get()).get('turns')).toBe(1);
        expect(send).not.toHaveBeenCalled();
      },
    );

    it.each(['revision', 'history', 'pet'] as const)(
      'does not replay a completed greeting after the %s context is revoked',
      async (state) => {
        const f = await setup(`replay_${state}`);
        const original = await runProactiveTurn(f.rt, f.task, () => DAY);
        expect(original.fallback).toBe(false);
        await revokeContext(f.base, state);
        const replay = await runProactiveTurn(f.rt, f.task, () => DAY);
        expect(replay.fallback).toBe(true);
        expect(replay.greeting.text).not.toBe(original.greeting.text);
        expect((await f.receipt.get()).get('greeting')).toEqual(replay.greeting);
        expect(f.model.requests).toHaveLength(1);
        expect((await f.usage.get()).get('turns')).toBe(1);
      },
    );

    it('does not trust legacy greetings without a context version', async () => {
      const f = await setup('legacy_context');
      await f.receipt.set({
        greeting: { text: 'OLD_CONTEXT', expression: 'happy' },
        fallback: false,
        localDate: f.task.localDate,
        expireAt: new Date(DAY.getTime() + 86_400_000),
      });
      expect((await runProactiveTurn(f.rt, f.task, () => DAY)).fallback).toBe(true);
      expect(JSON.stringify((await f.receipt.get()).data())).not.toContain('OLD_CONTEXT');
      expect(f.model.requests).toHaveLength(0);
    });

    it('sends fixed-copy push once after persistence and never retries delivery on replay', async () => {
      const f = await setup('push_once');
      const send = vi.fn(async () => {
        expect((await f.receipt.get()).get('status')).toBe('completed');
        expect((await f.receipt.get()).get('pushStatus')).toBe('claimed');
        return { status: 'sent' as const, sent: 1, removed: 0, failed: 0 };
      });
      f.rt.childPush = { send };
      const result = await runProactiveTurn(f.rt, f.task, () => DAY);
      expect(result.fallback).toBe(false);
      expect(send).toHaveBeenCalledWith({ ...f.task, turnId: f.receipt.id });
      expect((await f.receipt.get()).get('pushStatus')).toBe('sent');
      expect(await runProactiveTurn(f.rt, f.task, () => DAY)).toEqual(result);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('does not push a fallback and keeps a home greeting when push fails', async () => {
      const f = await setup('push_failure');
      const send = vi.fn(async () => {
        throw new Error('private provider details');
      });
      f.rt.childPush = { send };
      const result = await runProactiveTurn(f.rt, f.task, () => DAY);
      expect(result.fallback).toBe(false);
      expect((await f.receipt.get()).get('pushStatus')).toBe('failed');
      expect(await runProactiveTurn(f.rt, f.task, () => DAY)).toEqual(result);
      expect(send).toHaveBeenCalledTimes(1);
      const night = await setup('push_night');
      night.rt.childPush = { send };
      expect((await runProactiveTurn(night.rt, night.task, () => NIGHT)).fallback).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      expect(f.logLines.join('\n')).not.toContain('private provider details');
    });

    it('claims before the model, refuses overlapping duplicates and replays the saved result', async () => {
      const f = await setup('overlap');
      const gate = holdModel(f.model);
      const first = runProactiveTurn(f.rt, f.task, () => DAY);
      try {
        await Promise.race([
          gate.entered,
          first.then(() => {
            throw new Error('model did not start');
          }),
        ]);
        expect((await f.receipt.get()).data()).toMatchObject({ status: 'running' });
        expect((await f.receipt.get()).get('localDate')).toBeUndefined();
        expect((await f.usage.get()).get('turns')).toBe(1);
        const duplicates = await Promise.allSettled(
          Array.from({ length: 4 }, () => runProactiveTurn(f.rt, f.task, () => DAY)),
        );
        for (const result of duplicates) {
          expect(result.status).toBe('rejected');
          if (result.status === 'rejected')
            expect(result.reason).toMatchObject({ code: 'ALREADY_EXISTS', status: 409 });
        }
        expect(gate.calls).toHaveBeenCalledTimes(1);
      } finally {
        gate.release();
      }
      const result = await first;
      expect(result.fallback).toBe(false);
      expect(await runProactiveTurn(f.rt, f.task, () => DAY)).toEqual(result);
      expect(gate.calls).toHaveBeenCalledTimes(1);
      expect((await f.usage.get()).get('turns')).toBe(1);
      const stored = (await f.receipt.get()).data()!;
      expect(Object.keys(stored).sort()).toEqual([
        'createdAt',
        'expireAt',
        'fallback',
        'greeting',
        'localDate',
        'memoryRevision',
        'modelHistoryResetAt',
        'petId',
        'slot',
        'status',
      ]);
      expect(stored['expireAt'].toMillis() - DAY.getTime()).toBe(
        agent.proactiveRetentionDays * 86_400_000,
      );
    });

    it('allows all three slots even when the independent chat quota is exhausted', async () => {
      const f = await setup('independent');
      const chat = db.doc(`${f.base}/chatUsage/${f.task.localDate}`);
      const modelUsage = db.doc(`${f.base}/chatUsage/${f.task.localDate}_model`);
      await chat.set({ turns: agent.dailyTurnLimit });
      await modelUsage.set({ checks: agent.dailyModelCheckLimit });
      const results = await Promise.all(
        (['morning', 'after_school', 'bedtime'] as const).map((slot) =>
          runProactiveTurn(f.rt, { ...f.task, slot }, () => DAY),
        ),
      );
      expect(results.every((result) => !result.fallback)).toBe(true);
      expect((await f.usage.get()).get('turns')).toBe(3);
      expect((await chat.get()).data()).toEqual({ turns: agent.dailyTurnLimit });
      expect((await modelUsage.get()).data()).toEqual({ checks: agent.dailyModelCheckLimit });
      expect(f.model.requests).toHaveLength(3);
      expect(await runProactiveTurn(f.rt, f.task, () => DAY)).toEqual(results[0]);
      const other = await setup('independent_other');
      expect((await runProactiveTurn(other.rt, other.task, () => DAY)).fallback).toBe(false);
    });

    it('does not oversubscribe the last daily reservation across concurrent slots', async () => {
      const f = await setup('quota_race');
      await f.usage.set({ turns: agent.proactiveDailyLimit - 1 });
      const results = await Promise.allSettled(
        (['morning', 'after_school', 'bedtime'] as const).map((slot) =>
          runProactiveTurn(f.rt, { ...f.task, slot }, () => DAY),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results.filter((result) => result.status === 'rejected'))
        expect(result.reason).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
      expect((await f.usage.get()).get('turns')).toBe(agent.proactiveDailyLimit);
      expect((await db.collection(`${f.base}/proactiveTurns`).get()).size).toBe(1);
      expect(f.model.requests).toHaveLength(1);
    });

    it('rejects past/future new work, accepts JST midnight, and replays completed old work', async () => {
      const f = await setup('dates');
      const midnight = new Date('2026-10-05T15:00:00Z');
      for (const localDate of ['2026-10-05', '2026-10-07'])
        await expect(
          runProactiveTurn(f.rt, { ...f.task, localDate }, () => midnight),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', status: 400 });
      expect((await f.usage.get()).exists).toBe(false);
      expect((await f.sessionRef.get()).exists).toBe(false);
      const result = await runProactiveTurn(f.rt, f.task, () => midnight);
      expect(await runProactiveTurn(f.rt, f.task, () => new Date('2026-10-06T15:00:00Z'))).toEqual(
        result,
      );
      expect(f.model.requests).toHaveLength(1);
    });

    it('replays current-version receipts without requiring a persistent session or KB', async () => {
      const f = await setup('versioned_receipt');
      const result = {
        greeting: { text: 'Saved.', expression: 'caring' },
        fallback: false,
        petRequest: { requestId: 'req_saved', type: 'drawing' },
      };
      await f.receipt.create({
        ...result,
        localDate: f.task.localDate,
        slot: f.task.slot,
        petId: f.child.petId,
        memoryRevision: 0,
        modelHistoryResetAt: null,
      });
      vi.spyOn(kb, 'yaml').mockRejectedValue(new Error('offline'));
      expect(await runProactiveTurn(f.rt, f.task, () => new Date('2026-10-07T03:00:00Z'))).toEqual(
        result,
      );
      expect((await f.usage.get()).exists).toBe(false);
      expect(f.model.requests).toHaveLength(0);
    });

    it('recovers an interrupted claim with one fixed result and no model or session creation', async () => {
      const f = await setup('interrupted');
      await f.usage.set({ turns: 1 });
      await f.receipt.create({
        status: 'running',
        leaseUntil: DAY,
        expireAt: new Date(DAY.getTime() + 86_400_000),
      });
      const results = await Promise.all(
        Array.from({ length: 3 }, () => runProactiveTurn(f.rt, f.task, () => DAY)),
      );
      expect(results[0]?.fallback).toBe(true);
      for (const result of results) expect(result).toEqual(results[0]);
      expect(await runProactiveTurn(f.rt, f.task, () => DAY)).toEqual(results[0]);
      expect((await f.sessionRef.get()).exists).toBe(false);
      expect((await f.usage.get()).get('turns')).toBe(1);
      expect(f.model.requests).toHaveLength(0);
    });

    it('fences a late worker after another delivery recovers its expired lease', async () => {
      const f = await setup('late');
      const gate = holdModel(f.model);
      let at = DAY;
      const first = runProactiveTurn(f.rt, f.task, () => at);
      let recovered;
      try {
        await Promise.race([
          gate.entered,
          first.then(() => {
            throw new Error('model did not start');
          }),
        ]);
        at = new Date(DAY.getTime() + agent.proactiveLeaseMs);
        recovered = await runProactiveTurn(f.rt, f.task, () => at);
        expect(recovered.fallback).toBe(true);
      } finally {
        gate.release();
      }
      expect(await first).toEqual(recovered);
      expect(await runProactiveTurn(f.rt, f.task, () => at)).toEqual(recovered);
      expect(gate.calls).toHaveBeenCalledTimes(1);
      expect((await f.usage.get()).get('turns')).toBe(1);
    });

    it('saves and replays a model failure without refunding or repeating the attempt', async () => {
      const f = await setup(
        'model_error',
        new ScriptedLlm(() => {
          throw new Error('private failure content');
        }),
      );
      const first = await runProactiveTurn(f.rt, f.task, () => DAY);
      expect(first.fallback).toBe(true);
      expect(await runProactiveTurn(f.rt, f.task, () => DAY)).toEqual(first);
      expect(f.model.requests).toHaveLength(1);
      expect((await f.usage.get()).get('turns')).toBe(1);
      expect(f.logLines.join('')).not.toContain('private failure content');
    });

    it('returns 503 on a lost completion write and recovers without replaying the model', async () => {
      const f = await setup('write_error');
      await f.rt.sessions.createSession({
        appName: PET_APP_NAME,
        userId: f.child.childId,
        sessionId: f.sessionId,
      });
      const transaction = db.runTransaction.bind(db);
      const write = vi.spyOn(db, 'runTransaction').mockImplementation((fn, options) =>
        transaction(async (tx) => {
          const set = tx.set.bind(tx);
          vi.spyOn(tx, 'set').mockImplementation((ref, data) => {
            if (
              ref.path === f.receipt.path &&
              (data as Record<string, unknown>)['status'] === 'completed'
            )
              throw new Error('write unavailable');
            return set(ref, data);
          });
          return fn(tx);
        }, options),
      );
      await expect(runProactiveTurn(f.rt, f.task, () => DAY)).rejects.toMatchObject({
        code: 'MODEL_UNAVAILABLE',
        status: 503,
      });
      write.mockRestore();
      expect(f.model.requests).toHaveLength(1);
      await expect(runProactiveTurn(f.rt, f.task, () => DAY)).rejects.toMatchObject({
        status: 409,
      });
      const result = await runProactiveTurn(
        f.rt,
        f.task,
        () => new Date(DAY.getTime() + agent.proactiveLeaseMs),
      );
      expect(result.fallback).toBe(true);
      expect(f.model.requests).toHaveLength(1);
    });

    it('uses and persists fixed night copy at 23:00 without model, tools, messages or push', async () => {
      const f = await setup('night');
      const executor = vi.spyOn(f.rt, 'executorFor');
      const publish = vi.spyOn(f.rt, 'publish');
      const result = await runProactiveTurn(f.rt, f.task, () => NIGHT);
      const { replies } = await kb.yaml('prompts/rest-reminders.yaml', safeRepliesSchema);
      expect(result).toEqual({
        greeting: { text: replies[f.child.gradeBand], expression: 'caring' },
        fallback: true,
      });
      expect(await runProactiveTurn(f.rt, f.task, () => NIGHT)).toEqual(result);
      expect(f.model.requests).toHaveLength(0);
      expect(executor).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect((await f.sessionRef.get()).exists).toBe(false);
      expect((await f.usage.get()).get('turns')).toBe(1);
    });

    it('replaces an in-flight 22:59 result with fixed copy if completion crosses 23:00', async () => {
      const f = await setup('night_boundary');
      const gate = holdModel(f.model);
      let at = new Date('2026-10-06T13:59:59Z');
      const first = runProactiveTurn(f.rt, f.task, () => at);
      try {
        await Promise.race([
          gate.entered,
          first.then(() => {
            throw new Error('model did not start');
          }),
        ]);
        at = NIGHT;
      } finally {
        gate.release();
      }
      const { replies } = await kb.yaml('prompts/rest-reminders.yaml', safeRepliesSchema);
      expect(await first).toEqual({
        greeting: { text: replies[f.child.gradeBand], expression: 'caring' },
        fallback: true,
      });
      expect(gate.calls).toHaveBeenCalledTimes(1);
    });

    it('keeps transcript reads/writes and all model state out of persistent sessions', async () => {
      const f = await setup('privacy');
      await f.rt.sessions.createSession({
        appName: PET_APP_NAME,
        userId: f.child.childId,
        sessionId: f.sessionId,
      });
      await f.rt.sessions.writeChildMessage(f.child.childId, f.sessionId, {
        text: 'PRIVATE_TRANSCRIPT',
        inputMode: 'typed',
        crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: DAY },
      });
      const readers = [
        vi.spyOn(f.rt.sessions, 'getSession'),
        vi.spyOn(f.rt.sessions, 'readMessageContext'),
        vi.spyOn(f.rt.sessions, 'readMessages'),
      ];
      const append = vi.spyOn(f.rt.sessions, 'appendEvent');
      const create = vi.spyOn(f.rt.sessions, 'createSession');
      const before = (await f.sessionRef.get()).data();
      await runProactiveTurn(f.rt, f.task, () => DAY);
      for (const read of readers) expect(read).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect((await f.sessionRef.get()).data()).toEqual(before);
      expect(JSON.stringify(f.model.requests)).not.toContain('PRIVATE_TRANSCRIPT');
      expect((await f.sessionRef.collection('messages').get()).size).toBe(1);
    });

    it.each(['ended', 'safe', 'crisis', 'inactive'] as const)(
      'rejects %s ownership/safety state before reserving quota',
      async (state) => {
        const f = await setup(`access_${state}`);
        await f.rt.sessions.createSession({
          appName: PET_APP_NAME,
          userId: f.child.childId,
          sessionId: f.sessionId,
        });
        if (state === 'ended') await f.sessionRef.update({ endedAt: DAY });
        if (state === 'safe') await f.sessionRef.update({ safeMode: true });
        if (state === 'crisis') await db.doc(`${f.base}/crisisEvents/open`).set({ status: 'open' });
        if (state === 'inactive') await db.doc(f.base).update({ status: 'deleted' });
        await expect(runProactiveTurn(f.rt, f.task, () => DAY)).rejects.toBeInstanceOf(
          ApiHttpError,
        );
        expect((await f.usage.get()).exists).toBe(false);
        expect((await f.receipt.get()).exists).toBe(false);
        expect(f.model.requests).toHaveLength(0);
      },
    );
  },
);
