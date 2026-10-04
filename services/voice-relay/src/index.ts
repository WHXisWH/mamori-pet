import { Logger, startService } from '@ijime/service-kit';

import { createApp, lazyBackend, SERVICE_NAME } from './app.js';
import { createVoiceBackend } from './backend.js';
import { createVoiceRuntime } from './runtime.js';
import { attachVoiceServer } from './server.js';

const backend = createVoiceRuntime().then(createVoiceBackend);
const allowedOrigins = (process.env['CHILD_WEB_ORIGIN'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const voice: { closeAll?: () => Promise<void> } = {};
const server = startService(
  createApp(() => backend),
  SERVICE_NAME,
  { beforeClose: () => voice.closeAll?.() },
);
voice.closeAll = attachVoiceServer(server, {
  backend: lazyBackend(backend),
  logger: new Logger(SERVICE_NAME),
  allowedOrigins,
}).closeAll;
