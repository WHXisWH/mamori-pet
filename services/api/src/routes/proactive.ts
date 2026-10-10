import { timingSafeEqual } from 'node:crypto';

import type { Firestore } from '@google-cloud/firestore';
import type { ProactiveDispatchRes } from '@ijime/api-types';
import {
  ApiHttpError,
  proactiveTurnSpec,
  type ServiceApp,
  type ServiceEnv,
  type TaskQueue,
} from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

const dispatchSchema = z.strictObject({
  slot: z.enum(['morning', 'after_school', 'bedtime']),
});

export type ProactiveRoutesDeps = {
  db: Firestore;
  queue: TaskQueue;
  petAgentUrl: string;
  dispatchToken?: string;
  now?: () => Date;
};

// 定数時間で比較する。長さが違っても早期に返さない
function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function localDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(now);
}

export function registerProactive(
  app: ServiceApp,
  getDeps: () => Promise<ProactiveRoutesDeps>,
): void {
  const r = app as unknown as Hono<ServiceEnv>;

  r.post('/internal/proactive-turns/dispatch', async (c) => {
    const deps = await getDeps();
    const expectedToken = deps.dispatchToken ?? process.env['PROACTIVE_DISPATCH_TOKEN'];
    if (!expectedToken || !tokenMatches(c.req.header('X-Internal-Token'), expectedToken))
      throw new ApiHttpError('UNAUTHENTICATED', 'internal token required');
    const parsed = dispatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', 'invalid proactive slot');
    const now = deps.now?.() ?? new Date();
    const date = localDate(now);
    const children = await deps.db
      .collectionGroup('children')
      .where('status', '==', 'active')
      .get();
    let queued = 0;
    let skipped = 0;
    for (const child of children.docs) {
      const data = child.data();
      const slots = data['proactiveSlots'];
      if (
        data['proactiveEnabled'] === false ||
        (Array.isArray(slots) && !slots.includes(parsed.data.slot))
      ) {
        skipped += 1;
        continue;
      }
      await deps.queue.enqueue(
        proactiveTurnSpec(deps.petAgentUrl, {
          childId: child.id,
          slot: parsed.data.slot,
          localDate: date,
        }),
      );
      queued += 1;
    }
    const body: ProactiveDispatchRes = {
      slot: parsed.data.slot,
      localDate: date,
      queued,
      skipped,
    };
    return c.json(body);
  });
}
