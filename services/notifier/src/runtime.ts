import { resolve } from 'node:path';

import { Firestore } from '@google-cloud/firestore';
import { createGemini } from '@ijime/agent-core';
import { loadEnv } from '@ijime/config';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import {
  AdcGoogleHttp,
  CloudTasksRestQueue,
  Logger,
  MemoryTaskQueue,
  type TaskQueue,
} from '@ijime/service-kit';

import { FcmSender, LogOnlySender, MemorySender } from './channels.js';
import type { NotifierDeps } from './deps.js';
import {
  BigQueryDailyFeatures,
  MemoryDailyFeatures,
  type DailyFeatureSource,
} from './weekly-source.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

export async function createRuntime(overrides: Partial<NotifierDeps> = {}): Promise<NotifierDeps> {
  const env = loadEnv();
  const logger = overrides.logger ?? new Logger('notifier');
  const prod = env.NODE_ENV === 'production';
  const kb =
    overrides.kb ?? (await Kb.load(new FsKbSource(resolve(env.KB_LOCAL_DIR ?? 'kb/v0.1.0'))));
  const db = overrides.db ?? new Firestore({ projectId: env.GCP_PROJECT_ID ?? 'demo-ijime' });
  const selfUrl = overrides.selfUrl ?? process.env['SELF_URL'] ?? 'http://localhost:8080';

  let tasks: TaskQueue | undefined = overrides.tasks;
  if (!tasks) {
    tasks = prod
      ? new CloudTasksRestQueue({
          projectId: env.GCP_PROJECT_ID!,
          location: env.GCP_REGION,
          invokerServiceAccount: required('TASKS_INVOKER_SA'),
          audience: selfUrl,
          http: new AdcGoogleHttp(),
        })
      : new MemoryTaskQueue();
  }

  const senders = overrides.senders ?? {
    webpush: prod ? new FcmSender(env.GCP_PROJECT_ID!, new AdcGoogleHttp()) : new MemorySender(),
    email: new LogOnlySender('email', logger),
    sms: new LogOnlySender('sms', logger),
  };

  if (!overrides.model && !env.GCP_PROJECT_ID)
    throw new Error(
      'Notifier requires GCP_PROJECT_ID and an explicit model ID, or an injected test model',
    );
  const model =
    overrides.model ??
    createGemini('notificationWriter', {
      projectId: env.GCP_PROJECT_ID!,
      location: env.GCP_REGION,
    });

  let features: DailyFeatureSource | undefined = overrides.features;
  if (!features) {
    if (prod || process.env['BIGQUERY_DATASET']) {
      const { BigQuery } = await import('@google-cloud/bigquery');
      features = new BigQueryDailyFeatures(
        new BigQuery({ projectId: env.GCP_PROJECT_ID!, location: env.GCP_REGION }),
        {
          projectId: env.GCP_PROJECT_ID!,
          dataset: process.env['BIGQUERY_DATASET'] ?? 'features_deid',
          location: env.GCP_REGION,
        },
      );
    } else {
      features = new MemoryDailyFeatures();
    }
  }

  const deps: NotifierDeps = {
    db,
    kb,
    model,
    tasks,
    senders,
    logger,
    selfUrl,
    features,
    now: overrides.now ?? (() => new Date()),
  };
  const origin = overrides.guardianWebOrigin ?? process.env['GUARDIAN_WEB_ORIGIN'];
  if (origin) deps.guardianWebOrigin = origin;
  return deps;
}
