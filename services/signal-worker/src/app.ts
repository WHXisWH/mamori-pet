import { withChildScope } from '@ijime/agent-core';
import {
  CRISIS_RECHECK_PATH,
  CRISIS_REDELIVERY_PATH,
  createServiceApp,
  crisisRecheckTaskSchema,
  crisisRedeliveryTaskSchema,
  eventSchemas,
  registerPushHandler,
  registerTaskHandler,
  type Logger,
  type ServiceApp,
} from '@ijime/service-kit';

import {
  ARTWORK_FEATURES_PATH,
  artworkFeaturesSchema,
  handleArtworkCreated,
  handleArtworkFeatures,
} from './artworks.js';
import { handleCheckinCreated } from './checkins.js';
import type { SignalWorkerDeps } from './deps.js';
import { handleMessageCreated } from './message.js';
import { handleCrisisRecheck } from './recheck.js';

export const SERVICE_NAME = 'signal-worker';

export function createApp(getDeps?: () => Promise<SignalWorkerDeps>, logger?: Logger): ServiceApp {
  const app = createServiceApp({
    name: SERVICE_NAME,
    version: process.env['SERVICE_VERSION'] ?? '0.1.0',
    ...(logger ? { logger } : {}),
  });
  app.use('*', (_c, next) => withChildScope(next));
  if (!getDeps) return app;
  let ready: Promise<SignalWorkerDeps> | undefined;
  const deps = () => (ready ??= getDeps());

  registerPushHandler(
    app,
    '/internal/events/message-created',
    eventSchemas['message.created'],
    async (ev) => handleMessageCreated(await deps(), ev),
  );
  registerPushHandler(
    app,
    '/internal/events/artwork-created',
    eventSchemas['artwork.created'],
    async (ev) => handleArtworkCreated(await deps(), ev),
  );
  registerPushHandler(
    app,
    '/internal/events/checkin-created',
    eventSchemas['checkin.created'],
    async (ev) => handleCheckinCreated(await deps(), ev),
  );
  registerTaskHandler(app, ARTWORK_FEATURES_PATH, artworkFeaturesSchema, async (req) =>
    handleArtworkFeatures(await deps(), req),
  );
  registerTaskHandler(app, CRISIS_RECHECK_PATH, crisisRecheckTaskSchema, async (task) =>
    handleCrisisRecheck(await deps(), task),
  );
  // api / voice-relay がリクエスト内で crisis.detected の発行に失敗したあとの再送。失敗したら 5xx を返し、キューがバックオフして再試行する
  registerTaskHandler(app, CRISIS_REDELIVERY_PATH, crisisRedeliveryTaskSchema, async (task) => {
    const d = await deps();
    await d.publisher.publish('crisis.detected', task);
    d.logger.warn('crisis.redelivered', { crisisId: task.crisisId });
  });
  return app;
}
