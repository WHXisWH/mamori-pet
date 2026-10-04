import { Firestore } from '@google-cloud/firestore';
import { afterAll, expect, it } from 'vitest';
import { persistSubmission } from './submission-store.js';

const db = new Firestore({ projectId: 'demo-api-deletion-race' });
afterAll(() => db.terminate());
it('cannot recreate submission or crisis content after deletion was requested', async () => {
  const root = 'families/f1/children/c1';
  await db.doc(root).set({ status: 'deleting' });
  for (const name of ['artworks', 'islandScenes', 'crisisEvents', 'moodCheckins']) {
    const ref = db.doc(`${root}/${name}/late`);
    await expect(persistSubmission(db, root, ref, { fixture: true })).rejects.toThrow(
      '利用できません',
    );
    expect((await ref.get()).exists).toBe(false);
  }
  await db.doc(root).update({ status: 'active' });
  const allowed = db.doc(`${root}/moodCheckins/active`);
  await persistSubmission(db, root, allowed, { fixture: true });
  expect((await allowed.get()).exists).toBe(true);
});
