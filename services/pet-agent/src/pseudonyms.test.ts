import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Firestore } from '@google-cloud/firestore';
import {
  DevChildDirectory,
  FirestoreSessionService,
  ScriptedLlm,
  disableAdkContentCapture,
} from '@ijime/agent-core';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createMemorySanitizer, createModelNameDetector } from './pseudonyms.js';

let db: Firestore;
let directory: DevChildDirectory;
let sessions: FirestoreSessionService;
beforeAll(() => {
  if (!process.env['FIRESTORE_EMULATOR_HOST']) throw new Error('needs Firestore emulator');
  disableAdkContentCapture();
  db = new Firestore({ projectId: `demo-pet-privacy-${process.pid}` });
  directory = new DevChildDirectory(db);
  sessions = new FirestoreSessionService(db, directory);
});
afterAll(() => db.terminate());

describe('encrypted per-child pseudonyms', () => {
  it('keeps stable aliases across concurrent calls and stores no names in plaintext', async () => {
    const child = (await directory.lookup('peer-map'))!;
    const detector = vi.fn(async (text: string) =>
      ['田中', '佐藤'].filter((name) => text.includes(name)),
    );
    const prepare = () => createMemorySanitizer({ db, child, sessions, detectNames: detector });
    const [a, b] = await Promise.all([prepare()('田中くんと遊ぶ'), prepare()('佐藤さんと話す')]);
    expect(a).toMatch(/^おともだち[A-B]くんと遊ぶ$/u);
    expect(b).toMatch(/^おともだち[A-B]さんと話す$/u);
    expect(a.slice(0, 6)).not.toBe(b.slice(0, 6));
    expect(await prepare()('田中くんと遊ぶ')).toBe(a);
    const ref = db.doc(`families/${child.familyId}/children/${child.childId}/private/pseudonyms`);
    const saved = await ref.get();
    expect(saved.get('mapEnc')).toBeInstanceOf(Buffer);
    expect(JSON.stringify(saved.data())).not.toContain('田中');
    const mapping = sessions.decryptForChild(
      child,
      Buffer.from(saved.get('mapEnc')),
      `${ref.path}#mapEnc`,
    );
    expect(mapping).toContain('田中');
    expect(mapping).toContain('佐藤');
    const other = (await directory.lookup('other-peer-map'))!;
    expect(() =>
      sessions.decryptForChild(other, Buffer.from(saved.get('mapEnc')), `${ref.path}#mapEnc`),
    ).toThrow();
  });

  it('memoizes already sanitized content and fails closed on model failure or invented names', async () => {
    const child = (await directory.lookup('peer-cache'))!;
    const detector = vi.fn(async () => ['田中']);
    const prepare = createMemorySanitizer({ db, child, sessions, detectNames: detector });
    const safe = await prepare('田中くん');
    expect(await prepare(safe)).toBe(safe);
    expect(detector).toHaveBeenCalledTimes(1);
    await expect(
      createMemorySanitizer({ db, child, sessions, detectNames: async () => ['架空名'] })(
        '田中くん',
      ),
    ).rejects.toThrow('invalid_person_names');
    await expect(
      createMemorySanitizer({
        db,
        child,
        sessions,
        detectNames: async () => {
          throw new Error('unavailable');
        },
      })('田中くん'),
    ).rejects.toThrow();
  });

  it('validates structured model extraction and rejects hallucinated substrings', async () => {
    const kb = await Kb.load(
      new FsKbSource(join(dirname(fileURLToPath(import.meta.url)), '../../../kb/v0.1.0')),
    );
    const model = new ScriptedLlm(() => ({ text: JSON.stringify({ names: ['ゆうた'] }) }));
    expect(await createModelNameDetector(kb, model)('ゆうたくんと遊ぶ')).toEqual(['ゆうた']);
    await expect(createModelNameDetector(kb, model)('いちごが好き')).rejects.toThrow(
      'memory_privacy_unavailable',
    );
  });
});
