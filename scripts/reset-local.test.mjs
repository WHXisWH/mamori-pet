import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findSupervisors,
  isPreviewSupervisor,
  parseArgs,
  previewAncestor,
  requireJava21,
  resetEnvironment,
} from './reset-local.mjs';

test('reset requires explicit execution; checks and help are non-destructive', () => {
  assert.equal(parseArgs([]).execute, false);
  assert.equal(parseArgs(['--check']).check, true);
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['--yes']).execute, true);
  assert.equal(parseArgs(['--yes', '--scripted']).scripted, true);
  for (const args of [['--force'], ['--yes', '--check'], ['--yes', '--yes']])
    assert.throws(() => parseArgs(args), /Usage|Choose/);
});

test('defaults reproduce the existing text-only real preview on 4300', () => {
  const env = resetEnvironment({});
  assert.equal(env.LOCAL_PORT_OFFSET, '1200');
  assert.equal(env.GCP_PROJECT_ID, 'zenn-hackathon-510109');
  assert.equal(env.NEXT_PUBLIC_API_BASE_URL, 'http://localhost:9280');
  assert.equal(env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:9295');
  assert.equal(env.NEXT_DIST_DIR, '.next/local-4300');
  assert.equal(env.VOICE_MODEL_MODE, 'disabled');
  assert.equal(env.GEMINI_MODEL_PET_CHAT, 'gemini-2.5-flash');
  assert.equal(env.GEMINI_MODEL_CRISIS_REVIEW, 'gemini-2.5-pro');
});

test('overrides stay within the isolated preview and do not mutate the caller environment', () => {
  const source = {
    LOCAL_PORT_OFFSET: '1400',
    GCP_REGION: 'us-central1',
    VOICE_MODEL_MODE: 'vertex',
    FIRESTORE_EMULATOR_HOST: 'remote.invalid:443',
    GOOGLE_APPLICATION_CREDENTIALS: '/private/adc.json',
  };
  const env = resetEnvironment(source);
  assert.equal(env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:9495');
  assert.equal(env.NEXT_PUBLIC_API_BASE_URL, 'http://localhost:9480');
  assert.equal(env.GCP_REGION, 'us-central1');
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, '/private/adc.json');
  assert.equal(env.VOICE_MODEL_MODE, 'disabled');
  assert.equal(source.VOICE_MODEL_MODE, 'vertex');
  assert.equal(source.FIRESTORE_EMULATOR_HOST, 'remote.invalid:443');
});

test('invalid production, cloud project, region, ports and build paths fail before process work', () => {
  for (const env of [
    { NODE_ENV: 'production' },
    { GCP_PROJECT_ID: 'not-the-test-project' },
    { LOCAL_PORT_OFFSET: '-1' },
    { LOCAL_PORT_OFFSET: '1.5' },
    { NEXT_DIST_DIR: '../../outside' },
    { GCP_REGION: 'https://remote.invalid' },
  ])
    assert.throws(() => resetEnvironment(env));
});

const root = '/project/ijime';
const supervisor = { cwd: root, command: 'node scripts/dev-local.mjs --manual', parentPid: 1 };

test('only exact local-preview commands with the matching repo cwd are owned', () => {
  for (const command of [
    'node scripts/dev-local.mjs',
    'node scripts/dev-local.mjs --manual',
    '/nvm/bin/node ./scripts/dev-local.mjs --real',
    `node ${root}/scripts/dev-local.mjs --manual`,
  ])
    assert.equal(isPreviewSupervisor({ ...supervisor, command }, root), true);
  for (const command of [
    'node scripts/manual-preview.mjs --run',
    'node scripts/dev-local.mjs.bak',
    'node scripts/dev-local.mjs --unrecognized',
    'sh -c node scripts/dev-local.mjs',
    'node /different/repo/scripts/dev-local.mjs --manual',
    'node --eval "scripts/dev-local.mjs"',
  ])
    assert.equal(isPreviewSupervisor({ ...supervisor, command }, root), false);
  assert.equal(isPreviewSupervisor({ ...supervisor, cwd: '/other/project' }, root), false);
  assert.equal(isPreviewSupervisor(undefined, root), false);
});

test('nested Next, worker and Java descendants resolve to the one supervisor', () => {
  const processes = new Map([
    [10, supervisor],
    [20, { cwd: root, command: 'node firebase.js', parentPid: 10 }],
    [30, { cwd: root, command: 'java -jar emulator.jar', parentPid: 20 }],
    [40, { cwd: root, command: 'next-server', parentPid: 10 }],
  ]);
  const inspect = (pid) => processes.get(pid);
  assert.equal(previewAncestor(30, inspect, root), 10);
  assert.equal(previewAncestor(40, inspect, root), 10);
  assert.deepEqual(
    findSupervisors([4300, 9295], (port) => (port === 4300 ? [40] : [30]), inspect, root),
    [10],
  );
});

test('unknown listeners and mixed previews abort before returning a stop plan', () => {
  const processes = new Map([
    [10, supervisor],
    [11, supervisor],
    [20, { cwd: '/foreign', command: 'node app.js', parentPid: 1 }],
  ]);
  const inspect = (pid) => processes.get(pid);
  assert.throws(
    () => findSupervisors([4300, 4301], (port) => (port === 4300 ? [10] : [20]), inspect, root),
    /not owned/,
  );
  assert.throws(
    () => findSupervisors([4300, 4301], (port) => (port === 4300 ? [10] : [11]), inspect, root),
    /multiple previews/,
  );
  assert.deepEqual(
    findSupervisors([4300], () => [], inspect, root),
    [],
  );
});

test('missing or cyclic ancestry cannot accidentally target another process', () => {
  assert.equal(
    previewAncestor(99, () => undefined, root),
    undefined,
  );
  assert.equal(
    previewAncestor(20, () => ({ cwd: root, command: 'node other.js', parentPid: 20 }), root),
    undefined,
  );
});

test('Java versions below the emulator requirement fail before stopping anything', () => {
  requireJava21({ status: 0, stderr: 'openjdk version "21.0.12-ea"' });
  requireJava21({ status: 0, stderr: 'java version "25.0.1"' });
  for (const result of [
    { status: 0, stderr: 'openjdk version "17.0.9"' },
    { status: 0, stderr: 'java version "1.8.0_402"' },
    { status: 1, stderr: 'Could not locate a Java Runtime' },
    { status: 0, stdout: '' },
  ])
    assert.throws(() => requireJava21(result), /Java 21/);
});
