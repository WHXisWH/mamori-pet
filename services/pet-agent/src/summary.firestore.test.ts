import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FieldValue, Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  PET_APP_NAME,
  OutputFilter,
  ScriptedLlm,
  disableAdkContentCapture,
} from '@ijime/agent-core';
import { FsKbSource, Kb, outputFilterSchema } from '@ijime/kb-loader';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createModelSummaryGenerator, maybeWriteAgentSummary } from './summary.js';
import { readChildContext } from './context.js';

let db: Firestore;
let directory: DevChildDirectory;
let sessions: FirestoreSessionService;
let kb: Kb;
beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  disableAdkContentCapture();
  db = new Firestore({ projectId: `demo-pet-summary-${process.pid}` });
  directory = new DevChildDirectory(db);
  sessions = new FirestoreSessionService(db, directory);
  kb = await Kb.load(
    new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
  );
});
afterAll(() => db.terminate());

async function fixture(id: string) {
  const child = (await directory.lookup(id))!;
  const session = await sessions.createSession({ appName: PET_APP_NAME, userId: id });
  const base = `families/${child.familyId}/children/${id}`;
  await db.doc(`${base}/sessions/${session.id}`).update({ turnCount: 6 });
  await sessions.writeChildMessage(id, session.id, {
    text: '学校で絵を描いた。',
    inputMode: 'typed',
    crisisCheck: { hit: false, method: 'none', score: 0, checkedAt: new Date() },
  });
  return { child, session, base };
}

describe('model summary persistence', () => {
  it('encrypts model summaries, deduplicates a turn and respects approval before recall', async () => {
    const { child, session, base } = await fixture('summary-model');
    const model = new ScriptedLlm(() => ({
      text: JSON.stringify({ summary: '学校での創作活動を楽しんでいる。' }),
    }));
    const generate = vi.fn(
      createModelSummaryGenerator(
        kb,
        model,
        new OutputFilter(await kb.yaml('rules/output_filter.yaml', outputFilterSchema)),
      ),
    );
    expect(
      await maybeWriteAgentSummary(db, sessions, child, session.id, new Date(), generate),
    ).toBe(true);
    const saved = (await db.doc(base).get()).get('agentSummary');
    expect(saved).toMatchObject({
      approved: false,
      source: 'model',
      throughTurn: 6,
      sessionId: session.id,
    });
    expect(saved).not.toHaveProperty('text');
    expect(JSON.stringify(saved)).not.toContain('創作');
    expect((await readChildContext(db, kb, child, new Date(), sessions)).recentTrend).toBe('');
    await db.doc(base).update({ 'agentSummary.approved': true });
    expect((await readChildContext(db, kb, child, new Date(), sessions)).recentTrend).toBe(
      '学校での創作活動を楽しんでいる。',
    );
    expect(
      await maybeWriteAgentSummary(db, sessions, child, session.id, new Date(), generate),
    ).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('does not send suspended, crisis or expired messages into the summary model', async () => {
    const { child, session, base } = await fixture('summary-filter');
    const path = `${base}/sessions/${session.id}/messages`;
    for (const kind of ['pending', 'crisis', 'expired']) {
      const { messageId } = await sessions.writeChildMessage(child.childId, session.id, {
        text: `private-${kind}`,
        inputMode: 'typed',
        crisisCheck: {
          hit: kind === 'crisis',
          method: 'none',
          score: 0,
          checkedAt: new Date(),
          ...(kind === 'pending' ? { pendingReview: true } : {}),
        },
      });
      if (kind === 'expired')
        await db.doc(`${path}/${messageId}`).update({ expireAt: new Date(0) });
    }
    const generate = vi.fn(async () => '学校のことを話している。');
    await maybeWriteAgentSummary(db, sessions, child, session.id, new Date(), generate);
    expect(generate).toHaveBeenCalledWith([{ role: 'child', text: '学校で絵を描いた。' }]);
  });

  it('does not recall an approved summary belonging to another pet', async () => {
    const { child, session, base } = await fixture('summary-other-pet');
    await maybeWriteAgentSummary(
      db,
      sessions,
      child,
      session.id,
      new Date(),
      async () => '学校で絵を描いた。',
    );
    await db.doc(base).update({
      'agentSummary.approved': true,
      'agentSummary.petId': 'another-pet',
    });
    expect((await readChildContext(db, kb, child, new Date(), sessions)).recentTrend).toBe('');
    await db.doc(base).update({
      'agentSummary.petId': FieldValue.delete(),
    });
    expect((await readChildContext(db, kb, child, new Date(), sessions)).recentTrend).toBe('');
    await db.doc(base).update({
      'agentSummary.petId': child.petId,
      activePetId: 'new-active-pet',
    });
    expect((await readChildContext(db, kb, child, new Date(), sessions)).recentTrend).toBe('');
  });

  it('does not resurrect deleted memory history when reset happens during generation', async () => {
    const { child, session, base } = await fixture('summary-reset');
    const generate = async () => {
      await db.doc(base).update({ modelHistoryResetAt: new Date() });
      return '古い話題';
    };
    expect(
      await maybeWriteAgentSummary(db, sessions, child, session.id, new Date(), generate),
    ).toBe(false);
    expect((await db.doc(base).get()).get('agentSummary')).toBeUndefined();
  });

  it('does not replace summaries with a fabricated success when generation fails', async () => {
    const { child, session, base } = await fixture('summary-error');
    const generate = async () => {
      throw new Error('summary_generation_failed');
    };
    await expect(
      maybeWriteAgentSummary(db, sessions, child, session.id, new Date(), generate),
    ).rejects.toThrow('summary_generation_failed');
    expect((await db.doc(base).get()).get('agentSummary')).toBeUndefined();
  });
});
