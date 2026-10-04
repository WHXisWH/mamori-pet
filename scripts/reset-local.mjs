#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { localEnvironment, localPorts } from './local-ports.mjs';
import { configuration, PROJECT } from './manual-preview.mjs';

const FILE = fileURLToPath(import.meta.url);
export const ROOT = realpathSync(resolve(dirname(FILE), '..'));

export function parseArgs(args) {
  const allowed = new Set(['--yes', '--check', '--scripted', '--help']);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length)
    throw new Error('Usage: pnpm dev:reset [--yes|--check] [--scripted]');
  if (args.includes('--yes') && args.includes('--check'))
    throw new Error('Choose --yes or --check, not both');
  return {
    execute: args.includes('--yes'),
    check: args.includes('--check'),
    scripted: args.includes('--scripted'),
    help: args.includes('--help'),
  };
}

export function resetEnvironment(source, scripted = false) {
  if (source.NODE_ENV === 'production') throw new Error('Local reset is not allowed in production');
  const env = {
    ...source,
    LOCAL_PORT_OFFSET: source.LOCAL_PORT_OFFSET ?? '1200',
    NODE_ENV: 'test',
    REAL_BUSINESS_APPROVED: '1',
    LOCAL_MANUAL_PREVIEW: '1',
    GCP_PROJECT_ID: source.GCP_PROJECT_ID ?? PROJECT,
    GCP_REGION: source.GCP_REGION ?? 'asia-northeast1',
    VOICE_MODEL_MODE: 'disabled',
    GEMINI_MODEL_PET_CHAT: source.GEMINI_MODEL_PET_CHAT ?? 'gemini-2.5-flash',
    GEMINI_MODEL_CRISIS_SCREEN: source.GEMINI_MODEL_CRISIS_SCREEN ?? 'gemini-2.5-flash',
    GEMINI_MODEL_CRISIS_REVIEW: source.GEMINI_MODEL_CRISIS_REVIEW ?? 'gemini-2.5-pro',
    GEMINI_MODEL_SIGNAL_EXTRACT: source.GEMINI_MODEL_SIGNAL_EXTRACT ?? 'gemini-2.5-flash',
    GEMINI_MODEL_ARTWORK_FEATURE: source.GEMINI_MODEL_ARTWORK_FEATURE ?? 'gemini-2.5-flash',
    GEMINI_MODEL_NOTIFICATION_WRITER: source.GEMINI_MODEL_NOTIFICATION_WRITER ?? 'gemini-2.5-pro',
  };
  const ports = localPorts(env);
  env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${ports.firestore}`;
  Object.assign(env, localEnvironment(env));
  if (!scripted) configuration(env);
  return env;
}

export function isPreviewSupervisor(record, root = ROOT) {
  if (!record || record.cwd !== root) return false;
  const match = /^(\S+)\s+(.+)$/.exec(record.command);
  if (!match || !/(?:^|\/)node$/.test(match[1])) return false;
  const commands = [
    'scripts/dev-local.mjs',
    './scripts/dev-local.mjs',
    `${root}/scripts/dev-local.mjs`,
  ];
  return commands.some((command) =>
    ['', ' --manual', ' --real'].some((flag) => match[2] === command + flag),
  );
}

export function previewAncestor(pid, inspect, root = ROOT) {
  const visited = new Set();
  for (let i = 0; pid > 1 && i < 24 && !visited.has(pid); i++) {
    visited.add(pid);
    const record = inspect(pid);
    if (isPreviewSupervisor(record, root)) return pid;
    if (!record) return undefined;
    pid = record.parentPid;
  }
  return undefined;
}

function output(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function listeners(port) {
  try {
    return [
      ...new Set(
        output('lsof', ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number),
      ),
    ];
  } catch (error) {
    if (error.status === 1 && !String(error.stderr ?? '').trim()) return [];
    throw new Error('Cannot inspect local ports. Install lsof before using this script.');
  }
}

function inspectProcess(pid) {
  try {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(
      output('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'args=']),
    );
    if (!match) return undefined;
    const cwd = output('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1);
    return { parentPid: Number(match[1]), command: match[2], cwd };
  } catch {
    return undefined;
  }
}

export function findSupervisors(
  ports,
  readListeners = listeners,
  inspect = inspectProcess,
  root = ROOT,
) {
  const owners = new Set();
  for (const port of ports) {
    for (const pid of readListeners(port)) {
      const owner = previewAncestor(pid, inspect, root);
      if (!owner)
        throw new Error(
          `Port ${port} is not owned by this project's preview. Nothing was stopped.`,
        );
      owners.add(owner);
    }
  }
  if (owners.size > 1)
    throw new Error('Selected ports belong to multiple previews. Nothing was stopped.');
  return [...owners];
}

async function stopPreview(owners, ports) {
  for (const pid of owners) {
    if (!isPreviewSupervisor(inspectProcess(pid)))
      throw new Error('Preview owner changed; reset cancelled.');
  }
  for (const pid of owners) process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (ports.every((port) => listeners(port).length === 0)) return;
    await delay(250);
  }
  throw new Error(
    'Preview did not release its ports. Stop its original terminal and retry; no force-kill was used.',
  );
}

async function run(command, args, env) {
  const child = spawn(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  let cancelled = false;
  const stop = (signal) => {
    cancelled = true;
    child.kill(signal);
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    const code = await new Promise((ok, fail) => {
      child.once('error', fail);
      child.once('exit', (code) => ok(code ?? 1));
    });
    if (cancelled) throw new Error('Stopped by user');
    if (code !== 0) throw new Error(`Local command failed (exit ${code})`);
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

function node22() {
  const versions = join(process.env.NVM_DIR || join(homedir(), '.nvm'), 'versions/node');
  const version =
    existsSync(versions) &&
    readdirSync(versions)
      .filter((name) => /^v22\.\d+\.\d+$/.test(name))
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      .find((name) => existsSync(join(versions, name, 'bin/node')));
  if (!version) throw new Error('Node.js 22 is required. Run nvm install 22 && nvm use 22.');
  return join(versions, version, 'bin/node');
}

export function requireJava21(result) {
  const version = /version\s+"(?:1\.)?(\d+)/.exec(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error || result.status !== 0 || !version || Number(version[1]) < 21)
    throw new Error('Java 21+ is required before resetting. Set JAVA_HOME to a compatible JDK.');
}

function prerequisites(env, scripted) {
  if (!env.JAVA_HOME && process.platform === 'darwin') {
    try {
      env.JAVA_HOME = output('/usr/libexec/java_home', ['-v', '21']).trim();
    } catch {
      /* JAVA_HOME stays unset; the Java version check below reports it. */
    }
  }
  env.PATH = [
    dirname(process.execPath),
    ...(env.JAVA_HOME ? [join(env.JAVA_HOME, 'bin')] : []),
    env.PATH,
  ]
    .filter(Boolean)
    .join(':');
  requireJava21(
    spawnSync(env.JAVA_HOME ? join(env.JAVA_HOME, 'bin/java') : 'java', ['-version'], {
      env,
      encoding: 'utf8',
    }),
  );
  try {
    execFileSync('pnpm', ['--version'], { env, stdio: 'pipe' });
  } catch {
    throw new Error('pnpm must be installed before resetting.');
  }
  if (!existsSync(join(ROOT, 'node_modules')))
    throw new Error('Run pnpm install before resetting.');
  if (!scripted) {
    const adc =
      env.GOOGLE_APPLICATION_CREDENTIALS ||
      join(
        env.CLOUDSDK_CONFIG || join(env.HOME || homedir(), '.config/gcloud'),
        'application_default_credentials.json',
      );
    if (!existsSync(adc))
      throw new Error('Google ADC is missing. Run gcloud auth application-default login first.');
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help || (!options.execute && !options.check)) {
    process.stdout.write(
      'Usage: pnpm dev:reset --yes [--scripted]\nRead-only check: pnpm dev:reset --check\nResets ALL local test data. Re-register the family and pair again.\n',
    );
    return;
  }
  if (Number(process.versions.node.split('.')[0]) !== 22) {
    await run(node22(), [FILE, ...args], process.env);
    return;
  }
  const env = resetEnvironment(process.env, options.scripted);
  prerequisites(env, options.scripted);
  const ports = localPorts(env);
  const allPorts = Object.values(ports);
  const owners = findSupervisors(allPorts);
  process.stdout.write(
    `\nReset scope: local test families, pairing, chats and other emulator data on ports ${ports.child}/${ports.guardian}.\nCloud resources, Google credentials and unrelated processes are not modified.\nVoice is disabled. ${options.scripted ? 'Scripted models; no Google calls.' : 'Real Gemini mode; usage is billed when you interact.'}\n`,
  );
  if (options.check) {
    process.stdout.write(
      `Preflight passed. ${owners.length} owned preview(s). No data cleared, processes stopped or builds run.\n`,
    );
    return;
  }
  await stopPreview(owners, allPorts);
  process.stdout.write('Building the local preview...\n');
  await run(process.execPath, ['scripts/build-local.mjs'], { ...env, NODE_ENV: 'production' });
  process.stdout.write(
    `\nWhen startup reports ready, close old tabs and open these reset links in the same browser:\nChild: http://localhost:${ports.child}/pair?resetLocal=1\nGuardian: http://localhost:${ports.guardian}/signup?resetLocal=1\nBrowser state clears when you open each link. Register the guardian first for full pairing.\nKeep this terminal open. Ctrl+C stops the preview.\n\n`,
  );
  await run(
    process.execPath,
    ['scripts/dev-local.mjs', ...(options.scripted ? [] : ['--manual'])],
    env,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Local reset failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
