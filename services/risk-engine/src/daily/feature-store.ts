import type { BigQuery } from '@google-cloud/bigquery';

// BigQuery の features_deid には非識別化した数値だけを置く。行には pseudo_id だけがあり、childId もテキストも含まない
export type DailyFeatureRow = {
  pseudo_id: string;
  feature_date: string;
  domain: string;
  feature_name: string;
  value: number;
  grade_band: string;
  kb_version: string;
};

export type BaselineRow = {
  pseudo_id: string;
  feature_name: string;
  day_type: string;
  median: number;
  iqr: number;
  window_days: number;
  computed_at: string;
};

export type RiskLevelRow = {
  pseudo_id: string;
  date: string;
  level: string;
  domains_flagged: string[];
  rules_version: string;
};

export type PartitionRows = {
  daily_features: DailyFeatureRow[];
  baselines: BaselineRow[];
  risk_levels_daily: RiskLevelRow[];
};
export type PartitionedTable = keyof PartitionRows;

export type AnomalyOptions = { retrain: boolean; threshold: number; modelVersion: string };

export interface FeatureStore {
  // 指定したテーブルの1日分のパーティションを load job で上書きする。ジョブを再実行しても結果は変わらない
  writePartition<T extends PartitionedTable>(
    table: T,
    date: string,
    rows: PartitionRows[T],
  ): Promise<void>;
  readDailyFeatures(
    pseudoIds: readonly string[],
    from: string,
    to: string,
  ): Promise<DailyFeatureRow[]>;
  refreshAnomalies(date: string, opts: AnomalyOptions): Promise<void>;
}

const PARTITION_FIELD: Record<PartitionedTable, string> = {
  daily_features: 'feature_date',
  baselines: 'DATE(computed_at)',
  risk_levels_daily: 'date',
};

export class MemoryFeatureStore implements FeatureStore {
  readonly partitions = new Map<string, unknown[]>();
  readonly anomalyRuns: { date: string; opts: AnomalyOptions }[] = [];

  async writePartition<T extends PartitionedTable>(
    table: T,
    date: string,
    rows: PartitionRows[T],
  ): Promise<void> {
    this.partitions.set(`${table}$${date}`, [...rows]);
  }

  rows<T extends PartitionedTable>(table: T, date: string): PartitionRows[T] {
    return (this.partitions.get(`${table}$${date}`) ?? []) as PartitionRows[T];
  }

  async readDailyFeatures(
    pseudoIds: readonly string[],
    from: string,
    to: string,
  ): Promise<DailyFeatureRow[]> {
    const ids = new Set(pseudoIds);
    const out: DailyFeatureRow[] = [];
    for (const [key, rows] of this.partitions) {
      const [table, date] = key.split('$') as [string, string];
      if (table !== 'daily_features' || date < from || date > to) continue;
      for (const r of rows as DailyFeatureRow[]) if (ids.has(r.pseudo_id)) out.push(r);
    }
    return out;
  }

  async refreshAnomalies(date: string, opts: AnomalyOptions): Promise<void> {
    this.anomalyRuns.push({ date, opts });
  }
}

export class BigQueryFeatureStore implements FeatureStore {
  constructor(
    private readonly bq: BigQuery,
    private readonly opts: { projectId: string; dataset: string; location: string },
  ) {}

  private ref(table: string): string {
    return `\`${this.opts.projectId}.${this.opts.dataset}.${table}\``;
  }

  async writePartition<T extends PartitionedTable>(
    table: T,
    date: string,
    rows: PartitionRows[T],
  ): Promise<void> {
    if (rows.length === 0) {
      await this.bq.query({
        query: `DELETE FROM ${this.ref(table)} WHERE ${PARTITION_FIELD[table]} = @d`,
        params: { d: date },
        types: { d: 'DATE' },
        location: this.opts.location,
      });
      return;
    }
    const target = this.bq.dataset(this.opts.dataset).table(`${table}$${date.replaceAll('-', '')}`);
    await new Promise<void>((resolve, reject) => {
      const stream = target.createWriteStream({
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
        location: this.opts.location,
      });
      stream.on('error', reject);
      stream.on('complete', () => resolve());
      stream.end(rows.map((r) => JSON.stringify(r)).join('\n'));
    });
  }

  async readDailyFeatures(
    pseudoIds: readonly string[],
    from: string,
    to: string,
  ): Promise<DailyFeatureRow[]> {
    if (pseudoIds.length === 0) return [];
    const [rows] = await this.bq.query({
      query: `SELECT pseudo_id, CAST(feature_date AS STRING) AS feature_date, domain, feature_name,
                value, grade_band, kb_version
              FROM ${this.ref('daily_features')}
              WHERE feature_date BETWEEN @from AND @to AND pseudo_id IN UNNEST(@ids)`,
      params: { from, to, ids: [...pseudoIds] },
      types: { from: 'DATE', to: 'DATE', ids: ['STRING'] },
      location: this.opts.location,
    });
    return rows as DailyFeatureRow[];
  }

  // 第二の判定基準：ARIMA_PLUS を毎週再学習し、ML.DETECT_ANOMALIES の結果で anomalies の当日パーティションを上書きする
  async refreshAnomalies(date: string, opts: AnomalyOptions): Promise<void> {
    const model = this.ref('arima_daily');
    const series = `SELECT pseudo_id, feature_name, TIMESTAMP(feature_date) AS ts, value
                    FROM ${this.ref('daily_features')} WHERE domain != 'x'`;
    if (opts.retrain) {
      await this.bq.query({
        query: `CREATE OR REPLACE MODEL ${model}
                OPTIONS (model_type = 'ARIMA_PLUS', time_series_timestamp_col = 'ts',
                  time_series_data_col = 'value', time_series_id_col = ['pseudo_id', 'feature_name'],
                  data_frequency = 'DAILY')
                AS ${series} AND feature_date BETWEEN DATE_SUB(@d, INTERVAL 90 DAY) AND DATE_SUB(@d, INTERVAL 1 DAY)`,
        params: { d: date },
        types: { d: 'DATE' },
        location: this.opts.location,
      });
    }
    const [job] = await this.bq.createQueryJob({
      query: `SELECT pseudo_id, feature_name, DATE(ts) AS feature_date, is_anomaly,
                anomaly_probability, lower_bound, upper_bound, @model_version AS model_version
              FROM ML.DETECT_ANOMALIES(MODEL ${model}, STRUCT(@threshold AS anomaly_prob_threshold),
                (${series} AND feature_date = @d))`,
      params: { d: date, threshold: opts.threshold, model_version: opts.modelVersion },
      types: { d: 'DATE', threshold: 'FLOAT64', model_version: 'STRING' },
      destination: this.bq
        .dataset(this.opts.dataset)
        .table(`anomalies$${date.replaceAll('-', '')}`),
      writeDisposition: 'WRITE_TRUNCATE',
      location: this.opts.location,
    });
    await job.getQueryResults();
  }
}
