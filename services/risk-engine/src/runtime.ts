import { resolve } from 'node:path';

import { Firestore } from '@google-cloud/firestore';
import { loadEnv } from '@ijime/config';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import {
  AdcGoogleHttp,
  CloudTasksRestQueue,
  Logger,
  MemoryPublisher,
  MemoryTaskQueue,
  PubSubRestPublisher,
} from '@ijime/service-kit';

import { MemoryExternalChildData, type ExternalChildData } from './deletion.js';
import type { RiskEngineDeps } from './deps.js';
import { CloudExternalChildData } from './external-data.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export async function createRuntime(
  overrides: Partial<RiskEngineDeps> = {},
): Promise<RiskEngineDeps> {
  const env = loadEnv();
  const prod = env.NODE_ENV === 'production';
  const kb =
    overrides.kb ?? (await Kb.load(new FsKbSource(resolve(env.KB_LOCAL_DIR ?? 'kb/v0.1.0'))));
  const db = overrides.db ?? new Firestore({ projectId: env.GCP_PROJECT_ID ?? 'demo-ijime' });
  const notifierUrl =
    overrides.notifierUrl ?? process.env['NOTIFIER_URL'] ?? 'http://localhost:8085';
  return {
    db,
    kb,
    publisher:
      overrides.publisher ??
      (env.GCP_PROJECT_ID && (prod || env.PUBSUB_EMULATOR_HOST)
        ? PubSubRestPublisher.fromEnv(env.GCP_PROJECT_ID)
        : new MemoryPublisher()),
    tasks:
      overrides.tasks ??
      (prod
        ? new CloudTasksRestQueue({
            projectId: env.GCP_PROJECT_ID!,
            location: env.GCP_REGION,
            invokerServiceAccount: required('TASKS_INVOKER_SA'),
            audience: notifierUrl,
            http: new AdcGoogleHttp(),
          })
        : new MemoryTaskQueue()),
    logger: overrides.logger ?? new Logger('risk-engine'),
    notifierUrl,
    external: overrides.external ?? (await externalChildData(env, prod)),
    now: overrides.now ?? (() => new Date()),
  };
}

// 本番では作品バケットと BigQuery を消す。ローカルとテストはメモリ実装
async function externalChildData(
  env: ReturnType<typeof loadEnv>,
  prod: boolean,
): Promise<ExternalChildData> {
  if (!prod) return new MemoryExternalChildData();
  const [{ Storage }, { BigQuery }] = await Promise.all([
    import('@google-cloud/storage'),
    import('@google-cloud/bigquery'),
  ]);
  const projectId = env.GCP_PROJECT_ID!;
  return new CloudExternalChildData(
    new Storage().bucket(required('ARTWORKS_BUCKET')),
    new BigQuery({ projectId, location: env.GCP_REGION }),
    {
      projectId,
      dataset: process.env['BIGQUERY_DATASET'] ?? 'features_deid',
      location: env.GCP_REGION,
    },
  );
}
