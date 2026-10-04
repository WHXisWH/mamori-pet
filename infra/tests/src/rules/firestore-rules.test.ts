import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, deleteDoc } from 'firebase/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(join(here, '../../../terraform/firestore.rules'), 'utf8');

let env: RulesTestEnvironment;

beforeAll(async () => {
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  if (!host) throw new Error('FIRESTORE_EMULATOR_HOST not set: run via firebase emulators:exec');
  const [hostname, port] = host.split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-ijime',
    firestore: { rules, host: hostname!, port: Number(port) },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'families/f_1/children/c_1'), { nickname: 'ゆい' });
    await setDoc(doc(ctx.firestore(), 'families/f_1/children/c_1/sessions/s_1/messages/m_1'), {
      role: 'child',
    });
    await setDoc(doc(ctx.firestore(), 'characters/moko'), { displayName: 'もこ' });
    await setDoc(doc(ctx.firestore(), 'hotlines/sos'), { phone: '0120-0-78310' });
  });
});

afterAll(async () => {
  await env?.cleanup();
});

const actors = () => [
  { name: 'unauthenticated', ctx: () => env.unauthenticatedContext() },
  {
    name: 'child token',
    ctx: () =>
      env.authenticatedContext('child-uid', { role: 'child', familyId: 'f_1', childId: 'c_1' }),
  },
  {
    name: 'guardian token',
    ctx: () =>
      env.authenticatedContext('guardian-uid', {
        role: 'guardian',
        familyId: 'f_1',
        guardianRole: 'primary',
      }),
  },
  { name: 'unrelated user', ctx: () => env.authenticatedContext('someone-else') },
];

describe('Firestore rules: every client is denied', () => {
  for (const actor of actors()) {
    describe(actor.name, () => {
      it('cannot read own child document', async () => {
        await assertFails(getDoc(doc(actor.ctx().firestore(), 'families/f_1/children/c_1')));
      });

      it('cannot read messages', async () => {
        await assertFails(
          getDoc(
            doc(actor.ctx().firestore(), 'families/f_1/children/c_1/sessions/s_1/messages/m_1'),
          ),
        );
      });

      it('cannot list a collection', async () => {
        await assertFails(getDocs(collection(actor.ctx().firestore(), 'families')));
      });

      it('cannot read public-looking master data', async () => {
        await assertFails(getDoc(doc(actor.ctx().firestore(), 'characters/moko')));
        await assertFails(getDoc(doc(actor.ctx().firestore(), 'hotlines/sos')));
      });

      it('cannot write anywhere', async () => {
        await assertFails(
          setDoc(doc(actor.ctx().firestore(), 'families/f_1/children/c_1/moodCheckins/x'), {
            weather: 'sunny',
          }),
        );
        await assertFails(setDoc(doc(actor.ctx().firestore(), 'anything/at-all'), { a: 1 }));
        await assertFails(deleteDoc(doc(actor.ctx().firestore(), 'families/f_1/children/c_1')));
      });
    });
  }

  it('rules file is the deny-all rule set', () => {
    expect(rules).toContain('allow read, write: if false;');
  });
});
