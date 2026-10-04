import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { localPorts } from './local-ports.mjs';
import {
  createRealBusinessRuntime,
  preflight,
  workerEnv,
  LIMITS,
} from './verify-real-business.mjs';

const file = fileURLToPath(import.meta.url);
const print = process.stdout.write.bind(process.stdout);
const ports = localPorts();

async function worker() {
  const deadline = Date.now() + LIMITS.totalMs - 1500;
  const stopAt = setTimeout(() => process.exit(0), LIMITS.totalMs);
  const origins = [ports.child, ports.guardian].flatMap((port) => [
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
  const runtime = await createRealBusinessRuntime({
    project: process.env.REAL_BUSINESS_PROJECT,
    deadline,
    allowedOrigins: origins,
  });
  const { serve } = createRequire(new URL('../packages/service-kit/package.json', import.meta.url))(
    '@hono/node-server',
  );
  const app = runtime.app;
  app.get('/local/status', (c) =>
    c.json({
      mode: 'real_vertex_local_database',
      externalDelivery: false,
      deadline: new Date(deadline).toISOString(),
      ...runtime.getReport(),
    }),
  );
  let draining = false;
  const drainTimer = setInterval(() => {
    if (draining) return;
    draining = true;
    void runtime
      .drain()
      .catch(() => {})
      .finally(() => {
        draining = false;
      });
  }, 1000);
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: ports.api });
  print(
    `Real Gemini preview: Tokyo, local database, no external delivery; max ${LIMITS.calls} model calls / 8 minutes.\n`,
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(drainTimer);
    clearTimeout(stopAt);
    server.closeAllConnections();
    server.close();
    await runtime.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  process.on('disconnect', () => void stop());
}

async function main() {
  if (process.argv[2] !== '--run') throw new Error('opt_in_required');
  if (process.send) return worker();
  const { adcPath } = preflight({ mode: 'run', cases: ['ordinary', 'memory', 'pipeline'] });
  const env = workerEnv(process.env, adcPath, `demo-real-${randomUUID()}`);
  const child = fork(file, ['--run'], {
    env,
    execArgv: [],
    stdio: ['ignore', 'inherit', 'ignore', 'ipc'],
  });
  // The child environment stays strictly allowlisted; preview ports travel through IPC.
  child.send(ports);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.once('error', () => {
    print('Real preview could not start.\n');
    process.exitCode = 1;
  });
  child.once('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

if (process.send) {
  process.once('message', (value) => {
    if (
      !value ||
      Object.keys(ports).some(
        (key) => !Number.isInteger(value[key]) || value[key] < 1024 || value[key] > 65535,
      )
    )
      process.exit(1);
    Object.assign(ports, value);
    void main().catch(() => {
      print('Real preview stopped; inspect prerequisites with verify:business --check.\n');
      process.exit(1);
    });
  });
} else {
  main().catch(() => {
    print('Real preview requires --run, approved test configuration, fresh builds and ADC.\n');
    process.exitCode = 1;
  });
}
