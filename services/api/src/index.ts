import { startService } from '@ijime/service-kit';

import { allowedOriginsFromEnv, createApp, SERVICE_NAME } from './app.js';
import { loadKb } from './kb.js';
import { createApiRuntime } from './runtime.js';

const runtime = createApiRuntime();

startService(
  createApp({
    getKb: () => loadKb(),
    allowedOrigins: allowedOriginsFromEnv(),
    chat: () => runtime.then((r) => r.chat),
    accounts: () => runtime.then((r) => r.accounts),
    guardian: () => runtime.then((r) => r.guardian),
    guardianDeletion: () => runtime.then((r) => r.guardianDeletion),
    submissions: () => runtime.then((r) => r.submissions),
    proactive: () => runtime.then((r) => r.proactive),
    calendar: () =>
      runtime.then(
        (r) => r.calendar ?? Promise.reject(new Error('Google OAuth client is not configured')),
      ),
  }),
  SERVICE_NAME,
);
