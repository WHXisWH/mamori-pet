import type { BigQuery } from '@google-cloud/bigquery';

// BigQuery features_deid.daily_features の1行（risk-engine の日次ジョブが書き込む。pseudo_id と数値だけを持つ）
export type DailyFeatureRow = {
  pseudo_id: string;
  feature_date: string;
  domain: string;
  feature_name: string;
  value: number;
};

export interface DailyFeatureSource {
  read(pseudoIds: readonly string[], from: string, to: string): Promise<DailyFeatureRow[]>;
}

export class MemoryDailyFeatures implements DailyFeatureSource {
  constructor(readonly rows: DailyFeatureRow[] = []) {}

  async read(pseudoIds: readonly string[], from: string, to: string): Promise<DailyFeatureRow[]> {
    const ids = new Set(pseudoIds);
    return this.rows.filter(
      (r) => ids.has(r.pseudo_id) && r.feature_date >= from && r.feature_date <= to,
    );
  }
}

export class BigQueryDailyFeatures implements DailyFeatureSource {
  constructor(
    private readonly bq: BigQuery,
    private readonly opts: { projectId: string; dataset: string; location: string },
  ) {}

  async read(pseudoIds: readonly string[], from: string, to: string): Promise<DailyFeatureRow[]> {
    if (pseudoIds.length === 0) return [];
    const [rows] = await this.bq.query({
      query: `SELECT pseudo_id, CAST(feature_date AS STRING) AS feature_date, domain, feature_name, value
              FROM \`${this.opts.projectId}.${this.opts.dataset}.daily_features\`
              WHERE feature_date BETWEEN @from AND @to AND pseudo_id IN UNNEST(@ids)`,
      params: { from, to, ids: [...pseudoIds] },
      types: { from: 'DATE', to: 'DATE', ids: ['STRING'] },
      location: this.opts.location,
    });
    return rows as DailyFeatureRow[];
  }
}
