import type { Server } from 'node:http';

import { serve } from '@hono/node-server';
import { lifecycle, loadEnv } from '@ijime/config';

import type { ServiceApp } from './app.js';
import { Logger } from './logger.js';

export type StartServiceOptions = {
  // シャットダウン時、HTTP サーバーを閉じる前に呼ぶ（例：長時間の接続をこちらから終了する）
  beforeClose?: () => void;
};

export function startService(
  app: ServiceApp,
  name: string,
  opts: StartServiceOptions = {},
): Server {
  const env = loadEnv();
  const logger = new Logger(name);
  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info('service.listening', { port: info.port, region: env.GCP_REGION });
  });

  const shutdown = (signal: string) => {
    logger.info('service.shutdown', { signal });
    opts.beforeClose?.();
    server.close((err) => {
      if (err) {
        logger.error('service.shutdown_error', { error: err });
        process.exit(1);
      }
      process.exit(0);
    });
    (server as Server).closeIdleConnections();
    setTimeout(() => process.exit(1), lifecycle.shutdownGraceMs).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server as Server;
}
