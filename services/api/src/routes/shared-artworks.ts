import {
  FieldPath,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
  type Transaction,
} from '@google-cloud/firestore';
import type { SharedArtworksRes } from '@ijime/api-types';
import { limits } from '@ijime/config';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';

import { ARTWORK_URL_TTL_MS } from '../artwork-io.js';
import { guardianAuth, type GuardianAuthEnv, type GuardianPrincipal } from '../auth.js';
import { familyOfGuardian } from './notifications.js';
import type { SubmissionDeps } from './submissions.js';
import { resourceId } from './workflow-store.js';

export type SharedArtworkDeps = Pick<SubmissionDeps, 'db' | 'auth' | 'images' | 'now'>;

export function artworkDate(value: unknown): Date | undefined {
  const date =
    value instanceof Date ? value : value instanceof Timestamp ? value.toDate() : undefined;
  return date && Number.isFinite(date.getTime()) ? date : undefined;
}

// Canonical equality prevents using a stored imageRef to sign another child's object.
export function isOwnArtworkImage(
  base: string,
  artworkId: string,
  imageRef: unknown,
): imageRef is string {
  return imageRef === `${base}/artworks/${resourceId(artworkId)}.png`;
}

export async function artworkFamilySafe(
  tx: Transaction,
  db: Firestore,
  base: string,
): Promise<boolean> {
  // Bounded fail-closed check also catches unknown/missing crisis status or safety flags.
  const crises = await tx.get(db.collection(`${base}/crisisEvents`).limit(limits.pageSize.max + 1));
  return (
    crises.size <= limits.pageSize.max &&
    !crises.docs.some((d) => d.get('status') !== 'closed' && d.get('familyHarmSuspected') !== false)
  );
}

async function authorize(
  tx: Transaction,
  deps: SharedArtworkDeps,
  principal: GuardianPrincipal,
  base: string,
) {
  const guardian = await tx.get(
    deps.db.doc(`families/${principal.familyId}/guardians/${resourceId(principal.guardianId)}`),
  );
  const child = await tx.get(deps.db.doc(base));
  if (
    !guardian.exists ||
    guardian.get('guardianId') !== principal.guardianId ||
    !['primary', 'secondary'].includes(guardian.get('role')) ||
    guardian.get('revokedAt') != null ||
    (guardian.get('status') !== undefined && guardian.get('status') !== 'active') ||
    child.get('status') !== 'active'
  )
    throw new ApiHttpError('NOT_FOUND', '作品が見つかりません');
  if (child.get('requiresGuardianConsent')) {
    const family = await tx.get(deps.db.doc(`families/${principal.familyId}`));
    if (family.get('status') !== 'active' || family.get('consentComplete') !== true)
      throw new ApiHttpError('NOT_FOUND', '作品が見つかりません');
  }
  return artworkFamilySafe(tx, deps.db, base);
}

function projection(doc: DocumentSnapshot, base: string, now: Date) {
  const data = doc.data();
  if (
    !data ||
    data['sharedWithGuardian'] !== true ||
    !isOwnArtworkImage(base, doc.id, data['imageRef']) ||
    !['drawing', 'self_portrait', 'story'].includes(String(data['type']))
  )
    return undefined;
  const expireAt = artworkDate(data['expireAt']);
  const sharedAt = artworkDate(data['sharedAt']);
  if (!expireAt || expireAt <= now || !sharedAt || sharedAt > now) return undefined;
  return {
    artworkId: doc.id,
    type: data['type'] === 'story' ? ('story' as const) : ('self_portrait' as const),
    imageRef: data['imageRef'],
    sharedAt: sharedAt.toISOString(),
    expires: expireAt.getTime(),
  };
}

/** GET projection only; never decrypts or returns narrative/features/risk. At most 20 rows/read. */
export function registerSharedArtworks(
  app: ServiceApp,
  getDeps: () => Promise<SharedArtworkDeps>,
): void {
  const r = app as unknown as Hono<GuardianAuthEnv & ServiceEnv>;
  const path = '/v1/children/:childId/shared-artworks';
  r.use(path, async (c, next) => {
    const deps = await getDeps();
    c.header('Cache-Control', 'no-store');
    return guardianAuth(deps.auth, (id) => familyOfGuardian(deps.db, id))(c, next);
  });
  r.get(path, async (c) => {
    const deps = await getDeps();
    const principal = c.get('guardian');
    const childId = resourceId(c.req.param('childId'));
    const base = `families/${principal.familyId}/children/${childId}`;
    const requested = Number(c.req.query('pageSize') ?? limits.pageSize.default);
    if (!Number.isSafeInteger(requested) || requested < 1)
      throw new ApiHttpError('INVALID_ARGUMENT', 'ページサイズが正しくありません');
    // Data PNGs can be up to 2 MiB each; never allow the general 100-row page here.
    const size = Math.min(requested, limits.pageSize.default);
    let query = deps.db
      .collection(`${base}/artworks`)
      .where('sharedWithGuardian', '==', true)
      .orderBy(FieldPath.documentId())
      .limit(size);
    const token = c.req.query('pageToken');
    if (token) query = query.startAfter(resourceId(token));
    const page = await deps.db.runTransaction(
      async (tx) => {
        if (!(await authorize(tx, deps, principal, base))) return undefined;
        return tx.get(query);
      },
      { readOnly: true },
    );
    if (!page) return c.json({ items: [] } satisfies SharedArtworksRes);
    if (!deps.images.readUrl)
      throw new ApiHttpError('MODEL_UNAVAILABLE', '画像の表示はまだ利用できません');
    const candidates: { source: NonNullable<ReturnType<typeof projection>>; imageUrl: string }[] =
      [];
    for (const doc of page.docs) {
      if (!projection(doc, base, deps.now())) continue;
      const source = await deps.db.runTransaction(
        async (tx) => {
          if (!(await authorize(tx, deps, principal, base))) return undefined;
          return projection(await tx.get(doc.ref), base, deps.now());
        },
        { readOnly: true },
      );
      if (!source) continue;
      let imageUrl: string | undefined;
      try {
        imageUrl = await deps.images.readUrl(
          source.imageRef,
          new Date(Math.min(source.expires, deps.now().getTime() + ARTWORK_URL_TTL_MS)),
        );
      } catch {
        throw new ApiHttpError('MODEL_UNAVAILABLE', '画像を読み込めませんでした');
      }
      if (imageUrl) candidates.push({ source, imageUrl });
    }
    // Signing may await I/O. Recheck every candidate, including those signed earlier in this page.
    const body = await deps.db.runTransaction(
      async (tx): Promise<SharedArtworksRes> => {
        if (!(await authorize(tx, deps, principal, base))) return { items: [] };
        const items: SharedArtworksRes['items'] = [];
        for (const candidate of candidates) {
          const fresh = projection(
            await tx.get(deps.db.doc(`${base}/artworks/${candidate.source.artworkId}`)),
            base,
            deps.now(),
          );
          if (
            !fresh ||
            fresh.imageRef !== candidate.source.imageRef ||
            fresh.sharedAt !== candidate.source.sharedAt ||
            fresh.expires !== candidate.source.expires
          )
            continue;
          items.push({
            artworkId: fresh.artworkId,
            type: fresh.type,
            sharedAt: fresh.sharedAt,
            imageUrl: candidate.imageUrl,
          });
        }
        return { items, ...(page.size === size ? { nextPageToken: page.docs.at(-1)!.id } : {}) };
      },
      { readOnly: true },
    );
    return c.json(body);
  });
}
