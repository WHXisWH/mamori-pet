import { startService } from '@ijime/service-kit';

import { createApp, SERVICE_NAME } from './app.js';
import { createRuntime } from './runtime.js';

startService(
  createApp(() => createRuntime()),
  SERVICE_NAME,
);
