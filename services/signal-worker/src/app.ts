import {
  createServiceApp,
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

export const SERVICE_NAME = 'signal-worker';

export function createApp(getDeps?: () => Promise<SignalWorkerDeps>, logger?: Logger): ServiceApp {
  const app = createServiceApp({
    name: SERVICE_NAME,
    version: process.env['SERVICE_VERSION'] ?? '0.1.0',
    ...(logger ? { logger } : {}),
  });
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
  return app;
}
