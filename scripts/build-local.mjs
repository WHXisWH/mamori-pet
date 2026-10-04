import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { localEnvironment } from './local-ports.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--app'))
  throw new Error('Usage: node scripts/build-local.mjs [--app]');

function run(command, commandArgs, cwd) {
  return new Promise((ok) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env: { ...process.env, ...localEnvironment() },
      stdio: 'inherit',
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', () => ok(1));
    child.on('exit', (code) => ok(code ?? 1));
  });
}

if (args[0] === '--app') {
  process.exitCode = await run('pnpm', ['exec', 'next', 'build'], process.cwd());
} else {
  const turbo = ['exec', 'turbo', 'run'];
  process.exitCode =
    (await run('pnpm', [...turbo, 'build', '--filter=./services/*'], root)) ||
    (await run(
      'pnpm',
      [...turbo, 'build:local', '--filter=@ijime/child-web', '--filter=@ijime/guardian-web'],
      root,
    ));
}
