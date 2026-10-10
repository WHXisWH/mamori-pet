import type { BigQuery } from '@google-cloud/bigquery';
import type { Bucket } from '@google-cloud/storage';

import type { ExternalChildData } from './deletion.js';

// features_deid のうち pseudo_id 単位で行を持つテーブル（docs/03-database.md BigQuery）
const PSEUDO_TABLES = ['daily_features', 'baselines', 'anomalies', 'risk_levels_daily'] as const;

/** 本番実装：作品バケットはプレフィックスで削除、BigQuery は仮名でテーブルごとに削除。どちらも繰り返し実行できる。 */
export class CloudExternalChildData implements ExternalChildData {
  constructor(
    private readonly bucket: Bucket,
    private readonly bq: BigQuery,
    private readonly opts: { projectId: string; dataset: string; location: string },
  ) {}

  async deleteArtworks(familyId: string, childId: string): Promise<number> {
    const prefix = `families/${familyId}/children/${childId}/`;
    const [files] = await this.bucket.getFiles({ prefix });
    await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
    return files.length;
  }

  async deleteFeatures(pseudoId: string): Promise<void> {
    for (const table of PSEUDO_TABLES) {
      await this.bq.query({
        query: `DELETE FROM \`${this.opts.projectId}.${this.opts.dataset}.${table}\` WHERE pseudo_id = @p`,
        params: { p: pseudoId },
        types: { p: 'STRING' },
        location: this.opts.location,
      });
    }
  }
}
