import { RITUAL_KINDS, type RitualKind, type RitualRes } from '@ijime/api-types';
import { island as islandConfig } from '@ijime/config';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { childAuth, type AuthEnv } from '../auth.js';
import { readJson } from './island.js';
import {
  islandCurrentPath,
  islandDoc,
  jstDate,
  loadIslandInTx,
  markRitualInTx,
  ritualsOf,
  ritualsPath,
  type RitualField,
} from './island-store.js';
import { submissionOwner } from './submission-guard.js';
import type { SubmissionDeps } from './submissions.js';

const ritualSchema = z.object({
  kind: z.enum(RITUAL_KINDS),
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const FIELD_OF: Record<RitualKind, RitualField> = { watered: 'watered', good_thing: 'goodThing' };

export function ritualDateAllowed(localDate: string, now: Date): boolean {
  const requested = Date.parse(`${localDate}T00:00:00Z`);
  const today = Date.parse(`${jstDate(now)}T00:00:00Z`);
  if (!Number.isFinite(requested)) return false;
  return Math.abs(requested - today) <= islandConfig.ritualDateSlackDays * 86_400_000;
}

export function registerRituals(app: ServiceApp, getDeps: () => Promise<SubmissionDeps>): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  r.use('/rituals', async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.post('/rituals', async (c) => {
    const deps = await getDeps();
    const req = await readJson(c.req.raw, ritualSchema, '形式が正しくありません');
    const { child, base } = await submissionOwner(deps, c.get('child').childId);
    const now = deps.now();
    if (!ritualDateAllowed(req.localDate, now))
      throw new ApiHttpError('INVALID_ARGUMENT', '日付が正しくありません');
    const field = FIELD_OF[req.kind];
    const body = await deps.db.runTransaction(async (tx): Promise<RitualRes> => {
      const owner = await tx.get(deps.db.doc(base));
      const snap = await tx.get(deps.db.doc(ritualsPath(base, req.localDate)));
      const island = await loadIslandInTx(tx, deps, child, base, now);
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (snap.get(field) === true)
        return { rituals: ritualsOf(snap.data()), goodThingCount: island.goodThingCount };
      const rituals = markRitualInTx(tx, deps.db, base, req.localDate, snap.data(), field, now);
      const goodThingCount = island.goodThingCount + (req.kind === 'good_thing' ? 1 : 0);
      if (req.kind === 'good_thing')
        tx.set(
          deps.db.doc(islandCurrentPath(base)),
          islandDoc(deps.sessions, child, base, { ...island, goodThingCount }, now),
        );
      return { rituals, goodThingCount };
    });
    c.header('Cache-Control', 'no-store');
    return c.json(body, 200);
  });
}
