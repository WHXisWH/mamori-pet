import { Firestore } from '@google-cloud/firestore';
import { afterAll, expect, it } from 'vitest';
import { readChild, writeSignals } from './store.js';

const db = new Firestore({ projectId: 'demo-signal-deletion' });
afterAll(() => db.terminate());
it('drops late extraction writes after the child is tombstoned or the source was removed', async () => {
  const root = 'families/f1/children/c1';
  const sourceRef = `${root}/moodCheckins/m1`;
  const input = {
    familyId: 'f1',
    childId: 'c1',
    sourceRef,
    occurredAt: new Date(),
    kbVersion: 'test',
    extractedBy: 'rule',
    now: new Date(),
  };
  const drafts = [{ signalDefId: 'M-MOOD-001', domain: 'm' as const, value: 1, explicit: false }];
  await db.doc(root).set({ status: 'deleting', familyId: 'f1', gradeBand: 'high' });
  await db.doc(sourceRef).set({ weather: 'rainy' });
  expect(await readChild(db, 'f1', 'c1')).toBeUndefined();
  await expect(writeSignals(db, input, drafts)).rejects.toThrow('source_deleted');
  await db.doc(root).update({ status: 'active' });
  await db.doc(sourceRef).delete();
  await expect(writeSignals(db, input, drafts)).rejects.toThrow('source_deleted');
  expect((await db.collection(`${root}/signals`).get()).empty).toBe(true);
});
