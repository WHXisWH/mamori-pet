import { Logger } from '@ijime/service-kit';

import { SERVICE_NAME } from './app.js';
import { createRuntime } from './runtime.js';
import { runSync } from './sync.js';

const logger = new Logger(SERVICE_NAME);

try {
  logger.info('job.start', {});
  const result = await runSync(await createRuntime({ logger }));
  logger.info('job.done', result);
} catch (err) {
  logger.error('job.failed', { reason: err instanceof Error ? err.name : 'unknown' });
  process.exitCode = 1;
}
