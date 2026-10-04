import { resolve } from 'node:path';

import { Firestore } from '@google-cloud/firestore';
import {
  createGemini,
  DevChildDirectory,
  FirestoreChildDirectory,
  FirestoreSessionService,
  type ChildDirectory,
} from '@ijime/agent-core';
import { loadEnv } from '@ijime/config';
import { KmsKeyWrapper, kmsKeyPath } from '@ijime/crypto';
import { FsKbSource, Kb } from '@ijime/kb-loader';
import { Logger, MemoryPublisher, PubSubRestPublisher } from '@ijime/service-kit';

import type { SignalWorkerDeps } from './deps.js';

export async function createRuntime(
  overrides: Partial<SignalWorkerDeps> & { directory?: ChildDirectory } = {},
): Promise<SignalWorkerDeps> {
  const env = loadEnv();
  const prod = env.NODE_ENV === 'production';
  if ((!overrides.model || !overrides.artworkModel) && !env.GCP_PROJECT_ID) {
    throw new Error(
      'Signal worker requires GCP_PROJECT_ID and explicit Gemini model IDs, or injected test models',
    );
  }
  const logger = overrides.logger ?? new Logger('signal-worker');
  const kb =
    overrides.kb ?? (await Kb.load(new FsKbSource(resolve(env.KB_LOCAL_DIR ?? 'kb/v0.1.0'))));
  const db = overrides.db ?? new Firestore({ projectId: env.GCP_PROJECT_ID ?? 'demo-ijime' });

  let directory = overrides.directory;
  if (!directory) {
    if (prod) {
      const { KeyManagementServiceClient } = await import('@google-cloud/kms');
      const keyName = kmsKeyPath({
        projectId: env.GCP_PROJECT_ID!,
        location: env.GCP_REGION,
        keyRing: env.KMS_KEY_RING,
        key: 'content',
      });
      directory = new FirestoreChildDirectory(
        db,
        new KmsKeyWrapper(new KeyManagementServiceClient() as never, keyName),
      );
    } else {
      directory = new DevChildDirectory(db);
    }
  }

  const publisher =
    overrides.publisher ??
    (env.GCP_PROJECT_ID && (prod || env.PUBSUB_EMULATOR_HOST)
      ? PubSubRestPublisher.fromEnv(env.GCP_PROJECT_ID)
      : new MemoryPublisher());
  const gemini = { projectId: env.GCP_PROJECT_ID!, location: env.GCP_REGION };
  const model = overrides.model ?? createGemini('signalExtract', gemini);
  const artworkModel = overrides.artworkModel ?? createGemini('artworkFeature', gemini);

  return {
    db,
    kb,
    sessions: overrides.sessions ?? new FirestoreSessionService(db, directory),
    directory,
    publisher,
    model,
    artworkModel,
    logger,
    now: overrides.now ?? (() => new Date()),
  };
}
