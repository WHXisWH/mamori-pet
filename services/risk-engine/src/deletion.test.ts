import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { encodePushEnvelope, Logger, MemoryPublisher, MemoryTaskQueue } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { DELETION_PATH, deletionRequestId, MemoryExternalChildData } from './deletion.js';
import type { RiskEngineDeps } from './deps.js';

const KB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0');
let db: Firestore;
let kb: Kb;

beforeAll(async () => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: 'demo-ijime-deletion' });
  kb = await Kb.load(new FsKbSource(KB_DIR));
});
afterAll(() => db.terminate());

const NOW = new Date('2026-10-11T03:00:00Z');

function world(suffix: string) {
  const familyId = `f_${suffix}`;
  const childId = `c_${suffix}`;
  const external = new MemoryExternalChildData();
  const lines: string[] = [];
  const deps: RiskEngineDeps = {
    db,
    kb,
    publisher: new MemoryPublisher(),
    tasks: new MemoryTaskQueue(),
    logger: new Logger('risk-engine-test', (line) => lines.push(line)),
    notifierUrl: 'http://notifier.test',
    external,
    now: () => NOW,
  };
  const app = createApp(async () => deps, deps.logger);
  const post = () =>
    app.request(DELETION_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encodePushEnvelope({ familyId, childId, scope: 'child' })),
    });
  const request = db.doc(`deletionRequests/${deletionRequestId(familyId, childId)}`);
  return { familyId, childId, external, lines, post, request };
}

describe('data.deletion_requested consumer', () => {
  it('purges artworks and features, then marks the request completed (idempotent)', async () => {
    const w = world('ok');
    await db
      .doc(`families/${w.familyId}/children/${w.childId}`)
      .set({ childId: w.childId, familyId: w.familyId, status: 'deleting', pseudoId: 'p_ok' });
    await w.request.set({
      familyId: w.familyId,
      childId: w.childId,
      status: 'accepted',
      requestedAt: new Date(),
      firestoreClearedAt: new Date(),
      deletionEventPublishedAt: new Date(),
    });
    w.external.artworks.set(`${w.familyId}/${w.childId}`, 3);
    w.external.features.add('p_ok');

    expect((await w.post()).status).toBe(204);
    expect(w.external.deletedArtworks).toEqual([`${w.familyId}/${w.childId}`]);
    expect(w.external.deletedFeatures).toEqual(['p_ok']);
    const done = (await w.request.get()).data()!;
    expect(done['status']).toBe('completed');
    expect(done['artworksDeleted']).toBe(3);
    expect(done['featuresPurged']).toBe(true);
    expect(done['completedAt']).toBeDefined();
    expect(w.lines.join('\n')).toContain('deletion.completed');

    // A redelivered event changes nothing.
    expect((await w.post()).status).toBe(204);
    expect(w.external.deletedArtworks).toHaveLength(1);
    expect(w.lines.join('\n')).toContain('already_completed');
  });

  it('retries later while the api has not finished clearing Firestore', async () => {
    const w = world('early');
    await w.request.set({ familyId: w.familyId, childId: w.childId, status: 'accepted' });
    expect((await w.post()).status).toBe(503);
    expect((await w.request.get()).get('status')).toBe('accepted');
    expect(w.external.deletedArtworks).toEqual([]);
  });

  it('skips unknown requests and family-scope events without touching anything', async () => {
    const w = world('unknown');
    expect((await w.post()).status).toBe(204);
    const app = createApp(async () => ({
      db,
      kb,
      publisher: new MemoryPublisher(),
      tasks: new MemoryTaskQueue(),
      logger: new Logger('risk-engine-test', () => {}),
      notifierUrl: 'http://notifier.test',
      external: w.external,
      now: () => NOW,
    }));
    const family = await app.request(DELETION_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(encodePushEnvelope({ familyId: w.familyId, scope: 'family' })),
    });
    expect(family.status).toBe(204);
    expect(w.external.deletedArtworks).toEqual([]);
    expect(w.external.deletedFeatures).toEqual([]);
  });
});
