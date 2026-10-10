import {
  createServiceApp,
  eventSchemas,
  registerPushHandler,
  type Logger,
  type ServiceApp,
} from '@ijime/service-kit';

import type { RiskEngineDeps } from './deps.js';
import { DELETION_PATH, handleDeletion } from './deletion.js';
import { handleAssess, handleCrisis } from './event.js';

export const SERVICE_NAME = 'risk-engine';

export function createApp(getDeps?: () => Promise<RiskEngineDeps>, logger?: Logger): ServiceApp {
  const app = createServiceApp({
    name: SERVICE_NAME,
    version: process.env['SERVICE_VERSION'] ?? '0.1.0',
    ...(logger ? { logger } : {}),
  });
  if (!getDeps) return app;
  let ready: Promise<RiskEngineDeps> | undefined;
  const deps = () => (ready ??= getDeps());

  registerPushHandler(app, '/internal/assess', eventSchemas['signal.extracted'], async (ev) =>
    handleAssess(await deps(), ev),
  );
  registerPushHandler(
    app,
    '/internal/events/crisis-detected',
    eventSchemas['crisis.detected'],
    async (ev) => handleCrisis(await deps(), ev),
  );
  registerPushHandler(app, DELETION_PATH, eventSchemas['data.deletion_requested'], async (ev) =>
    handleDeletion(await deps(), ev),
  );
  return app;
}
