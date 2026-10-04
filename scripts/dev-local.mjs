import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { localEnvironment, localPorts } from './local-ports.mjs';
import { localMode } from './local-mode.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const childDir = resolve(root, 'apps/child-web');
const childRequire = createRequire(resolve(childDir, 'package.json'));
const guardianRequire = createRequire(resolve(root, 'apps/guardian-web/package.json'));
const ports = localPorts();
const mode = localMode(process.argv.slice(2));
const { real } = mode;
for (const port of Object.values(ports)) {
  await new Promise((ok, fail) => {
    const server = createServer();
    server.once('error', () =>
      fail(
        new Error(
          `Port ${port} is already in use. Choose a different LOCAL_PORT_OFFSET and rebuild the local preview.`,
        ),
      ),
    );
    server.listen(port, '127.0.0.1', () => server.close(ok));
  });
}
const env = {
  ...process.env,
  ...localEnvironment(),
  NODE_ENV: real ? 'test' : 'development',
  LOCAL_MANUAL_PREVIEW: mode.manual ? '1' : '0',
  FIRESTORE_EMULATOR_HOST: `127.0.0.1:${ports.firestore}`,
  GCP_PROJECT_ID: real ? process.env.GCP_PROJECT_ID : 'demo-ijime',
};
const configDir = await mkdtemp(resolve(tmpdir(), 'ijime-local-emulator-'));
const firebaseConfig = JSON.parse(await readFile(resolve(childDir, 'firebase.json'), 'utf8'));
for (const name of ['firestore', 'hub', 'logging'])
  firebaseConfig.emulators[name].port = ports[name];
const configPath = resolve(configDir, 'firebase.json');
await writeFile(configPath, JSON.stringify(firebaseConfig));
const children = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
function run(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
    if (
      stopping &&
      children.every((entry) => entry.exitCode !== null || entry.signalCode !== null)
    ) {
      void rm(configDir, { recursive: true, force: true });
    }
  });
  child.on('error', () => {
    process.exitCode = 1;
    stop();
  });
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
async function waitFor(url) {
  const until = Date.now() + 120_000;
  while (Date.now() < until && !stopping) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new Error(`Startup timeout: ${url}`);
}
run(
  [
    childRequire.resolve('firebase-tools/lib/bin/firebase.js'),
    '--config',
    configPath,
    'emulators:start',
    '--only',
    'firestore',
    '--project',
    'demo-ijime',
  ],
  childDir,
);
await waitFor(`http://127.0.0.1:${ports.hub}/emulators`);
run(mode.backend);
await waitFor(`http://127.0.0.1:${ports.api}/healthz`);
run(
  [
    childRequire.resolve('next/dist/bin/next'),
    'start',
    '-p',
    String(ports.child),
    '-H',
    '127.0.0.1',
  ],
  childDir,
);
run(
  [
    guardianRequire.resolve('next/dist/bin/next'),
    'start',
    '-p',
    String(ports.guardian),
    '-H',
    '127.0.0.1',
  ],
  resolve(root, 'apps/guardian-web'),
);
await waitFor(`http://127.0.0.1:${ports.child}`);
await waitFor(`http://127.0.0.1:${ports.guardian}`);
process.stdout.write(
  mode.manual
    ? '\nManual real Gemini preview ready. No total call/time cap; Google usage is billed. Synthetic testing only; no external notifications.\n'
    : real
      ? '\nBounded real Gemini preview ready. Synthetic testing only; no external notifications.\n'
      : '\nLocal scripted demo ready. No Google model calls or external notifications.\n',
);
process.stdout.write(
  `Child: http://localhost:${ports.child}\nGuardian: http://localhost:${ports.guardian}\nStop: Ctrl+C\n`,
);
