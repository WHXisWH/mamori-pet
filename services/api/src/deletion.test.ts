import { randomUUID } from 'node:crypto';

import { Firestore } from '@google-cloud/firestore';
import { createServiceApp, Logger, stableId } from '@ijime/service-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { registerDeletion, registerGuardianDeletion } from './routes/deletion.js';

let db: Firestore;
beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  db = new Firestore({ projectId: `demo-deletion-retry-${Date.now()}` });
});
afterAll(() => db.terminate());

async function fixture(role: 'primary' | 'secondary' = 'primary') {
  const suffix = randomUUID().replaceAll('-', '');
  const familyId = `f_${suffix}`;
  const childId = `c_${suffix}`;
  const guardianId = `g_${suffix}`;
  const child = db.doc(`families/${familyId}/children/${childId}`);
  const member = db.doc(`families/${familyId}/guardians/${guardianId}`);
  const memory = child.collection('memories').doc('synthetic');
  const notification = db.doc(`families/${familyId}/notifications/synthetic`);
  await child.set({ childId, familyId, status: 'active', memoryRevision: 0 });
  await member.set({ guardianId, role, status: 'active' });
  await memory.set({ contentEnc: Buffer.from('synthetic encrypted fixture') });
  await notification.set({ childId });
  const publish = vi.fn(async (_topic: string, _payload: Record<string, unknown>) => {});
  const deps = { db, publish, auth: { allowDevHeader: true } };
  const app = createServiceApp({ name: 'deletion-test', logger: new Logger('test', () => {}) });
  registerDeletion(app, async () => deps);
  registerGuardianDeletion(app, async () => deps);
  const request = (as: 'child' | 'guardian') =>
    app.request(
      as === 'child'
        ? '/v1/child/data-deletion-requests'
        : `/v1/children/${childId}/data-deletion-requests`,
      {
        method: 'POST',
        headers:
          as === 'child' ? { 'X-Dev-Child-Id': childId } : { 'X-Dev-Guardian-Id': guardianId },
      },
    );
  return {
    request,
    child,
    member,
    memory,
    notification,
    publish,
    childId,
    familyId,
    receipt: db.doc(`deletionRequests/delete-${stableId(familyId, childId)}`),
  };
}

describe.each(['child', 'guardian'] as const)('%s deletion recovery', (as) => {
  it.each(['child-content', 'notification', 'publish'] as const)(
    'resumes after a failed %s step, without repeating completed work',
    async (failure) => {
      const f = await fixture();
      const original = db.recursiveDelete.bind(db);
      let injected = false;
      const clear = vi.spyOn(db, 'recursiveDelete').mockImplementation(async (ref, writer) => {
        if (
          !injected &&
          (failure === 'child-content' ||
            (failure === 'notification' && ref.path === f.notification.path))
        ) {
          injected = true;
          throw new Error('synthetic clear failure');
        }
        return original(ref, writer);
      });
      if (failure === 'publish')
        f.publish.mockRejectedValueOnce(new Error('synthetic publish failure'));
      try {
        expect((await f.request(as)).status).toBe(500);
        const clearsAfterFailure = clear.mock.calls.length;
        expect((await f.receipt.get()).get('status')).toBe('accepted');
        expect((await f.request(as)).status).toBe(202);
        expect((await f.memory.get()).exists).toBe(false);
        expect((await f.notification.get()).exists).toBe(false);
        expect((await f.child.get()).data()).toMatchObject({
          status: 'deleting',
          memoryRevision: 1,
        });
        const receipt = await f.receipt.get();
        expect(receipt.get('firestoreClearedAt')).toBeDefined();
        expect(receipt.get('deletionEventPublishedAt')).toBeDefined();
        expect(receipt.get('completedAt')).toBeUndefined();
        if (failure === 'publish') expect(clear.mock.calls.length).toBe(clearsAfterFailure);
        const clearsAfterSuccess = clear.mock.calls.length;
        const publishesAfterSuccess = f.publish.mock.calls.length;
        expect((await f.request(as)).status).toBe(202);
        expect(clear.mock.calls.length).toBe(clearsAfterSuccess);
        expect(f.publish).toHaveBeenCalledTimes(publishesAfterSuccess);
        expect(f.publish).toHaveBeenLastCalledWith('data.deletion_requested', {
          familyId: f.familyId,
          childId: f.childId,
          scope: 'child',
        });
      } finally {
        clear.mockRestore();
      }
    },
  );
});

it('rejects a secondary guardian without deleting any child content', async () => {
  const f = await fixture('secondary');
  expect((await f.request('guardian')).status).toBe(403);
  expect((await f.memory.get()).exists).toBe(true);
  expect((await f.child.get()).get('status')).toBe('active');
  expect((await f.receipt.get()).exists).toBe(false);
  expect(f.publish).not.toHaveBeenCalled();
});

it('rechecks guardian revocation inside the accepting transaction', async () => {
  const f = await fixture();
  const run = db.runTransaction.bind(db);
  const spy = vi.spyOn(db, 'runTransaction').mockImplementationOnce(async (handler, options) => {
    await f.member.update({ revokedAt: new Date() });
    return run(handler, options);
  });
  try {
    expect((await f.request('guardian')).status).toBe(403);
    expect((await f.memory.get()).exists).toBe(true);
    expect((await f.receipt.get()).exists).toBe(false);
    expect(f.publish).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});
