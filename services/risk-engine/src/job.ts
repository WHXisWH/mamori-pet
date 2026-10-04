import { loadEnv } from '@ijime/config';
import { Logger } from '@ijime/service-kit';

import { SERVICE_NAME } from './app.js';
import { addDays, jstDate } from './daily/calendar.js';
import {
  BigQueryFeatureStore,
  MemoryFeatureStore,
  type FeatureStore,
} from './daily/feature-store.js';
import { runDailyJob } from './daily/job.js';
import { createRuntime } from './runtime.js';

// Cloud Run Job のエントリーポイント：既定では日本時間の前日を集計する。TARGET_DATE は特定の日を再実行するときに使う
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = new Logger(SERVICE_NAME);
  const deps = await createRuntime({ logger });
  const date = process.env['TARGET_DATE'] ?? addDays(jstDate(deps.now()), -1);
  let store: FeatureStore;
  if (env.NODE_ENV === 'production' || process.env['BIGQUERY_DATASET']) {
    const { BigQuery } = await import('@google-cloud/bigquery');
    store = new BigQueryFeatureStore(
      new BigQuery({ projectId: env.GCP_PROJECT_ID!, location: env.GCP_REGION }),
      {
        projectId: env.GCP_PROJECT_ID!,
        dataset: process.env['BIGQUERY_DATASET'] ?? 'features_deid',
        location: env.GCP_REGION,
      },
    );
  } else {
    store = new MemoryFeatureStore();
  }
  logger.info('job.start', { date });
  await runDailyJob({ ...deps, store }, date);
}

main().catch((err: unknown) => {
  new Logger(SERVICE_NAME).error('job.failed', {
    error: err instanceof Error ? err : new Error('unknown'),
  });
  process.exit(1);
});
