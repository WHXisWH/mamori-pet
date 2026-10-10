import { FieldValue } from '@google-cloud/firestore';
import type { CrisisAckRes } from '@ijime/api-types';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';
import { childOwner } from './workflow-store.js';

// 子どもが安全ページで「いまは安全」と確認する（2026-10-10 決定）。
// 家庭内の危害に分類されたイベントにだけ効く：この種のイベントは保護者に通知せず、子どもの代わりに確認できる人がいない。他の分類は引き続き保護者だけが確認する。
// 確認後、イベントは child_acknowledged になる：子どもはすぐペットのもとに戻れる。保護者向けの安全判断はさらに 24 時間待ってから終了扱いにする。
export function registerCrisisAcknowledgements(
  app: ServiceApp,
  getDeps: () => Promise<ChatDeps>,
): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  r.use('/crisis-acknowledgements', async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.post('/crisis-acknowledgements', async (c) => {
    const deps = await getDeps();
    const { base } = await childOwner(deps, c.get('child').childId);
    const now = new Date();
    const acknowledged = await deps.db.runTransaction(async (tx) => {
      const owner = await tx.get(deps.db.doc(base));
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      const open = await tx.get(
        deps.db
          .collection(`${base}/crisisEvents`)
          .where('status', '==', 'open')
          .where('familyHarmSuspected', '==', true),
      );
      for (const doc of open.docs)
        tx.update(doc.ref, {
          status: 'child_acknowledged',
          timeline: FieldValue.arrayUnion({ step: 'child_acknowledged', at: now }),
        });
      return open.size;
    });
    deps.logger.info('crisis.child_acknowledged', { count: acknowledged });
    const body: CrisisAckRes = { acknowledged };
    return c.json(body);
  });
}
