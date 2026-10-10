import { SkipEvent, stableId, type EventPayload } from '@ijime/service-kit';

import type { RiskEngineDeps } from './deps.js';

// data.deletion_requested の消費者（docs/03-database.md deletionRequests）。
// api は Firestore のサブコレクションを消してからイベントを発行する。ここでは Firestore 以外の 2 か所を消す：
// 作品の原画（Cloud Storage）と非識別化した特徴（BigQuery、pseudo_id 単位）。
// イベントは重複配信されうるので各手順は冪等。全部終えてから completed にする。
// バックアップ（Firestore のポイントインタイム リカバリ）は保存期間で自然に消えるため扱わない。
export const DELETION_PATH = '/internal/events/data-deletion-requested';

/** Firestore 以外にある子どものデータ。本番実装は runtime.ts、テストは MemoryExternalChildData。 */
export type ExternalChildData = {
  /** families/{f}/children/{c}/ 配下のオブジェクトをすべて削除し、件数を返す。 */
  deleteArtworks(familyId: string, childId: string): Promise<number>;
  /** features_deid の各テーブルからその仮名の行をすべて削除する。 */
  deleteFeatures(pseudoId: string): Promise<void>;
};

export class MemoryExternalChildData implements ExternalChildData {
  readonly artworks = new Map<string, number>();
  readonly features = new Set<string>();
  readonly deletedArtworks: string[] = [];
  readonly deletedFeatures: string[] = [];

  async deleteArtworks(familyId: string, childId: string): Promise<number> {
    const key = `${familyId}/${childId}`;
    const count = this.artworks.get(key) ?? 0;
    this.artworks.delete(key);
    this.deletedArtworks.push(key);
    return count;
  }

  async deleteFeatures(pseudoId: string): Promise<void> {
    this.features.delete(pseudoId);
    this.deletedFeatures.push(pseudoId);
  }
}

export function deletionRequestId(familyId: string, childId: string): string {
  return `delete-${stableId(familyId, childId)}`;
}

export async function handleDeletion(
  deps: RiskEngineDeps,
  ev: EventPayload<'data.deletion_requested'>,
): Promise<void> {
  const { db, external, logger } = deps;
  // api は子ども単位でしか発行しない。家族全体の削除は発行元がない（docs/03 の拡張余地）
  if (ev.scope !== 'child' || !ev.childId) throw new SkipEvent('family_scope_unsupported');
  const requestId = deletionRequestId(ev.familyId, ev.childId);
  const requestRef = db.doc(`deletionRequests/${requestId}`);
  const request = await requestRef.get();
  if (!request.exists) throw new SkipEvent('request_not_found');
  if (request.get('completedAt')) throw new SkipEvent('already_completed');
  // api は Firestore を消してから発行する。未完了なら Pub/Sub に後で再試行させ、先に完了扱いにはしない
  if (!request.get('firestoreClearedAt')) throw new Error('firestore_not_cleared');

  await requestRef.update({ status: 'running' });
  const child = await db.doc(`families/${ev.familyId}/children/${ev.childId}`).get();
  const pseudoId = child.get('pseudoId');
  if (typeof pseudoId === 'string' && pseudoId) await external.deleteFeatures(pseudoId);
  const artworksDeleted = await external.deleteArtworks(ev.familyId, ev.childId);
  await requestRef.update({
    status: 'completed',
    completedAt: deps.now(),
    artworksDeleted,
    featuresPurged: typeof pseudoId === 'string' && pseudoId !== '',
  });
  logger.info('deletion.completed', { requestId, artworksDeleted });
}
