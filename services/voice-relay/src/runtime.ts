import { resolve } from 'node:path';

import { Firestore } from '@google-cloud/firestore';
import {
  LocalChildDirectory,
  disableAdkContentCapture,
  FirestoreChildDirectory,
  FirestoreSessionService,
  OutputFilter,
  type ChildDirectory,
} from '@ijime/agent-core';
import type { PubSubTopic } from '@ijime/api-types';
import { isLocalManualPreview, loadEnv } from '@ijime/config';
import { createRuntimeDetector, loadHotlines, loadSafeModeCopy } from '@ijime/crisis-detector';
import { KmsKeyWrapper, kmsKeyPath } from '@ijime/crypto';
import { FsKbSource, Kb, outputFilterSchema, safeRepliesSchema } from '@ijime/kb-loader';
import {
  cloudRunIdToken,
  crisisRecheckRequesterFromEnv,
  Logger,
  PubSubRestPublisher,
} from '@ijime/service-kit';

import type { VoiceBackendDeps } from './backend.js';
import { httpToolCaller } from './forwarder.js';
import { ResumableGemini } from './live.js';
import { countMorae, loadTokenizer } from './mora.js';

export const RETRY_LINES_PATH = 'templates/voice_retry.ja.yaml';
export const PAUSED_LINES_PATH = 'templates/model_unavailable.ja.yaml';

export async function createVoiceRuntime(
  overrides: Partial<VoiceBackendDeps> = {},
): Promise<VoiceBackendDeps> {
  disableAdkContentCapture();
  const env = loadEnv();
  const prod = env.NODE_ENV === 'production';
  const logger = overrides.logger ?? new Logger('voice-relay');
  const kb =
    overrides.kb ?? (await Kb.load(new FsKbSource(resolve(env.KB_LOCAL_DIR ?? 'kb/v0.1.0'))));
  const db = overrides.db ?? new Firestore({ projectId: env.GCP_PROJECT_ID ?? 'demo-ijime' });

  let directory: ChildDirectory | undefined = overrides.directory;
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
      directory = new LocalChildDirectory(db);
    }
  }

  let publish = overrides.publish;
  if (!publish) {
    if (env.GCP_PROJECT_ID && (prod || env.PUBSUB_EMULATOR_HOST)) {
      const publisher = PubSubRestPublisher.fromEnv(env.GCP_PROJECT_ID);
      publish = (topic: PubSubTopic, payload) => publisher.publish(topic, payload as never);
    } else {
      publish = async (topic, payload) => {
        logger.info('pubsub.publish_skipped', { topic, keys: Object.keys(payload) });
      };
    }
  }

  const petAgentUrl = process.env['PET_AGENT_URL'] ?? 'http://localhost:8082';
  const createModel =
    overrides.createModel ??
    (() => {
      if (!prod && process.env['VOICE_MODEL_MODE'] !== 'vertex')
        throw new Error('voice model not configured (set VOICE_MODEL_MODE=vertex)');
      if (!env.GCP_PROJECT_ID) throw new Error('voice model requires GCP_PROJECT_ID');
      const model = new ResumableGemini({
        projectId: env.GCP_PROJECT_ID,
        location: isLocalManualPreview()
          ? (process.env['LIVE_REGION'] ?? env.GCP_REGION)
          : env.GCP_REGION,
      });
      return { model, connected: model.connected };
    });

  if (!overrides.countMorae) await loadTokenizer();

  return {
    db,
    directory,
    sessions:
      overrides.sessions ?? new FirestoreSessionService(db, directory, { writeUserEvents: false }),
    kb,
    detector:
      overrides.detector ??
      (await createRuntimeDetector(kb, process.env, {
        onModelEvent: (e) =>
          logger.warn('crisis.model_unavailable', {
            layer: e.layer,
            kind: e.kind,
            ...(e.reason ? { reason: e.reason } : {}),
          }),
      })),
    filter:
      overrides.filter ??
      new OutputFilter(await kb.yaml('rules/output_filter.yaml', outputFilterSchema)),
    safeReplies:
      overrides.safeReplies ??
      (await kb.yaml('prompts/safe_replies.yaml', safeRepliesSchema)).replies,
    retryLines:
      overrides.retryLines ?? (await kb.yaml(RETRY_LINES_PATH, safeRepliesSchema)).replies,
    pausedLines:
      overrides.pausedLines ?? (await kb.yaml(PAUSED_LINES_PATH, safeRepliesSchema)).replies,
    requestRecheck:
      overrides.requestRecheck ??
      crisisRecheckRequesterFromEnv({
        prod,
        projectId: env.GCP_PROJECT_ID,
        location: env.GCP_REGION,
      }),
    safeModeCopy: overrides.safeModeCopy ?? (await loadSafeModeCopy(kb)),
    hotlines: overrides.hotlines ?? (await loadHotlines(kb)).resources,
    publish,
    callTool:
      overrides.callTool ??
      httpToolCaller(petAgentUrl, prod ? cloudRunIdToken(petAgentUrl) : undefined),
    createModel,
    countMorae: overrides.countMorae ?? countMorae,
    logger,
    ...(overrides.now ? { now: overrides.now } : {}),
  };
}
