import { FieldValue } from '@google-cloud/firestore';
import type { MemoriesRes, MemoryProposalDecisionRes, MemoryProposalsRes } from '@ijime/api-types';
import { limits } from '@ijime/config';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { childAuth, type AuthEnv } from '../auth.js';
import type { ChatDeps } from '../chat.js';
import { childOwner, resourceId, storedDate } from './workflow-store.js';

export function registerMemories(app: ServiceApp, getDeps: () => Promise<ChatDeps>): void {
  const r = (app as unknown as Hono<AuthEnv & ServiceEnv>).basePath('/v1/child');
  for (const path of ['/memories', '/memories/*', '/memory-proposals', '/memory-proposals/*'])
    r.use(path, async (c, next) => childAuth((await getDeps()).auth)(c, next));

  r.get('/memories', async (c) => {
    const deps = await getDeps();
    const { child, base } = await childOwner(deps, c.get('child').childId);
    const size = z.coerce
      .number()
      .int()
      .min(1)
      .max(limits.pageSize.max)
      .safeParse(c.req.query('pageSize') ?? limits.pageSize.default);
    if (!size.success) throw new ApiHttpError('INVALID_ARGUMENT', 'ページサイズが正しくありません');
    const collection = deps.db.collection(`${base}/memories`);
    let query = collection.orderBy('createdAt', 'desc').limit(size.data + 1);
    const token = c.req.query('pageToken');
    if (token) {
      const cursor = await collection.doc(resourceId(token)).get();
      if (!cursor.exists) throw new ApiHttpError('INVALID_ARGUMENT', 'ページが見つかりません');
      query = query.startAfter(cursor);
    }
    const snap = await query.get();
    const docs = snap.docs.slice(0, size.data);
    const body: MemoriesRes = {
      items: docs.map((d) => ({
        memoryId: d.id,
        text: deps.sessions.decryptForChild(
          child,
          Buffer.from(d.get('contentEnc') as Uint8Array),
          `${base}/memories#contentEnc`,
        ),
        category: String(d.get('category')),
        createdAt: storedDate(d.get('createdAt'))!.toISOString(),
      })),
      ...(snap.size > size.data ? { nextPageToken: docs.at(-1)!.id } : {}),
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  r.delete('/memories/:memoryId', async (c) => {
    const deps = await getDeps();
    const { base, ref: childRef } = await childOwner(deps, c.get('child').childId);
    const id = resourceId(c.req.param('memoryId'));
    const ref = deps.db.doc(`${base}/memories/${id}`);
    const proposal = deps.db.doc(`${base}/memoryProposals/${id}`);
    await deps.db.runTransaction(async (tx) => {
      const savedProposal = await tx.get(proposal);
      tx.delete(ref);
      if (savedProposal.exists)
        tx.update(proposal, {
          status: 'deleted',
          contentEnc: FieldValue.delete(),
          deletedAt: new Date(),
        });
      tx.update(childRef, {
        agentSummary: FieldValue.delete(),
        memoryRevision: FieldValue.increment(1),
        modelHistoryResetAt: new Date(),
      });
    });
    return c.body(null, 204);
  });

  r.get('/memory-proposals', async (c) => {
    const deps = await getDeps();
    const { child, base } = await childOwner(deps, c.get('child').childId);
    const snap = await deps.db
      .collection(`${base}/memoryProposals`)
      .where('status', '==', 'pending')
      .get();
    const now = new Date();
    const body: MemoryProposalsRes = {
      items: snap.docs
        .filter((d) => {
          const expires = storedDate(d.get('expiresAt'));
          return (
            !!expires &&
            expires > now &&
            (!d.get('characterId') || d.get('characterId') === child.characterId) &&
            (!d.get('petId') || d.get('petId') === child.petId)
          );
        })
        .slice(0, limits.pageSize.max)
        .map((d) => ({
          proposalId: d.id,
          text: deps.sessions.decryptForChild(
            child,
            Buffer.from(d.get('contentEnc') as Uint8Array),
            `${base}/memoryProposals#contentEnc`,
          ),
          category: String(d.get('category')),
          expiresAt: storedDate(d.get('expiresAt'))!.toISOString(),
        })),
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  r.post('/memory-proposals/:id/decision', async (c) => {
    const parsed = z
      .strictObject({ decision: z.enum(['accept', 'reject']) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiHttpError('INVALID_ARGUMENT', '回答の形式が正しくありません');
    const deps = await getDeps();
    const { child, base, ref: childRef } = await childOwner(deps, c.get('child').childId);
    const id = resourceId(c.req.param('id'));
    const proposal = deps.db.doc(`${base}/memoryProposals/${id}`);
    const memory = deps.db.doc(`${base}/memories/${id}`);
    const result = await deps.db.runTransaction(async (tx): Promise<MemoryProposalDecisionRes> => {
      const owner = await tx.get(childRef);
      const snap = await tx.get(proposal);
      const saved = await tx.get(memory);
      const data = snap.data();
      if (owner.get('status') !== 'active')
        throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
      if (!data) throw new ApiHttpError('NOT_FOUND', '記憶の候補が見つかりません');
      const decision = parsed.data.decision;
      if (data['status'] === 'saved' && decision === 'accept' && saved.exists)
        return { status: 'saved', memoryId: id };
      if (data['status'] === 'rejected' && decision === 'reject') return { status: 'rejected' };
      if (data['status'] !== 'pending')
        throw new ApiHttpError('ALREADY_EXISTS', 'この候補は処理済みです');
      const expiresAt = storedDate(data['expiresAt']);
      if (!expiresAt || expiresAt <= new Date())
        throw new ApiHttpError('INVALID_ARGUMENT', '記憶の候補の期限が切れています');
      if (decision === 'reject') {
        tx.update(proposal, {
          status: 'rejected',
          decidedAt: new Date(),
          contentEnc: FieldValue.delete(),
        });
        return { status: 'rejected' };
      }
      if (
        (data['characterId'] && data['characterId'] !== child.characterId) ||
        (data['petId'] && data['petId'] !== child.petId) ||
        (owner.get('activePetId') && owner.get('activePetId') !== child.petId)
      )
        throw new ApiHttpError('INVALID_ARGUMENT', 'パートナーが変更されています');
      const text = deps.sessions.decryptForChild(
        child,
        Buffer.from(data['contentEnc'] as Uint8Array),
        `${base}/memoryProposals#contentEnc`,
      );
      tx.create(memory, {
        contentEnc: deps.sessions.encryptForChild(child, text, `${base}/memories#contentEnc`),
        category: data['category'],
        characterId: child.characterId,
        petId: child.petId,
        createdAt: new Date(),
        consentProposalId: id,
        consentedAt: new Date(),
        ...(typeof data['sourceMessageId'] === 'string'
          ? { sourceMessageId: data['sourceMessageId'] }
          : {}),
      });
      tx.update(proposal, {
        status: 'saved',
        decidedAt: new Date(),
        memoryId: id,
        contentEnc: FieldValue.delete(),
      });
      return { status: 'saved', memoryId: id };
    });
    return c.json(result);
  });
}
