import { createHash } from 'node:crypto';

import { FieldValue } from '@google-cloud/firestore';
import type { AgentSummaryRes } from '@ijime/api-types';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';
import { childOwner, storedDate } from './workflow-store.js';

function summaryOf(data: Record<string, unknown>, petId: string) {
  const summary = data['agentSummary'] as Record<string, unknown> | undefined;
  const expiry = storedDate(summary?.['expiresAt']);
  if (!summary?.['textEnc'] || !expiry || expiry <= new Date() || summary['petId'] !== petId)
    return undefined;
  const encrypted = Buffer.from(summary['textEnc'] as Uint8Array);
  const version = createHash('sha256').update(encrypted).digest('hex');
  return { encrypted, version, expiry, approved: summary['approved'] === true };
}

export function registerAgentSummary(app: ServiceApp, getDeps: () => Promise<ChatDeps>): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  for (const path of ['/agent-summary', '/agent-summary/decision'])
    r.use(path, async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.get('/agent-summary', async (c) => {
    const deps = await getDeps();
    const { child, base, data } = await childOwner(deps, c.get('child').childId);
    const saved = summaryOf(data, child.petId);
    const body: AgentSummaryRes = {
      summary: saved
        ? {
            version: saved.version,
            text: deps.sessions.decryptForChild(
              child,
              saved.encrypted,
              `${base}#agentSummary.textEnc`,
            ),
            approved: saved.approved,
            expiresAt: saved.expiry.toISOString(),
          }
        : null,
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  r.post('/agent-summary/decision', async (c) => {
    const input = z
      .strictObject({
        version: z.string().regex(/^[a-f0-9]{64}$/),
        decision: z.enum(['accept', 'reject']),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new ApiHttpError('INVALID_ARGUMENT', '回答の形式が正しくありません');
    const deps = await getDeps();
    const { child, ref } = await childOwner(deps, c.get('child').childId);
    await deps.db.runTransaction(async (tx) => {
      const owner = await tx.get(ref);
      if (
        owner.get('status') !== 'active' ||
        (owner.get('activePetId') && owner.get('activePetId') !== child.petId)
      )
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      const saved = summaryOf(owner.data() ?? {}, child.petId);
      if (!saved || saved.version !== input.data.version)
        throw new ApiHttpError(
          'ALREADY_EXISTS',
          'あたらしい おはなしが あります。もういちど みてね。',
        );
      tx.update(
        ref,
        input.data.decision === 'accept'
          ? { 'agentSummary.approved': true, 'agentSummary.approvedAt': new Date() }
          : {
              agentSummary: FieldValue.delete(),
              modelHistoryResetAt: new Date(),
              memoryRevision: FieldValue.increment(1),
            },
      );
    });
    return c.body(null, 204);
  });
}
