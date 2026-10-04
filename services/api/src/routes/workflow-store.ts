import type { DocumentData, DocumentReference } from '@google-cloud/firestore';
import { DATA_SOURCES, type DataSource } from '@ijime/api-types';
import { ApiHttpError } from '@ijime/service-kit';

import type { ChatDeps } from '../chat.js';

export function resourceId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new ApiHttpError('INVALID_ARGUMENT', 'ID の形式が正しくありません');
  return value;
}

export function storedDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in value)
    return (value as { toDate(): Date }).toDate();
  return undefined;
}

export function dataSourcesOf(data: DocumentData): Record<DataSource, boolean> {
  const sources = data['dataSources'] as Record<string, unknown> | undefined;
  return Object.fromEntries(DATA_SOURCES.map((key) => [key, sources?.[key] === true])) as Record<
    DataSource,
    boolean
  >;
}

export async function childOwner(deps: ChatDeps, childId: string, allowDeleting = false) {
  const child = await deps.directory.lookup(childId);
  if (!child) throw new ApiHttpError('NOT_FOUND', 'unknown child');
  const base = `families/${child.familyId}/children/${childId}`;
  const ref = deps.db.doc(base);
  const snap = await ref.get();
  const data = snap.data();
  if (!data) throw new ApiHttpError('NOT_FOUND', 'unknown child');
  if (data['status'] === 'deleting' && !allowDeleting)
    throw new ApiHttpError('PERMISSION_DENIED', 'データを削除しています');
  if (data['status'] === 'paused')
    throw new ApiHttpError('PERMISSION_DENIED', '利用が停止されています');
  return { child, base, ref, data };
}

export async function updateActiveChild(
  deps: ChatDeps,
  ref: DocumentReference,
  data: DocumentData,
) {
  await deps.db.runTransaction(async (tx) => {
    const owner = await tx.get(ref);
    if (owner.get('status') !== 'active')
      throw new ApiHttpError('PERMISSION_DENIED', '利用できません');
    tx.update(ref, data);
  });
}
