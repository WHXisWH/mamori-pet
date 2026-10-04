import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  CASES,
  Budget,
  classify,
  connectWithinSignal,
  diagnosticExitCode,
  parseArgs,
  safeRow,
  verifyReceipt,
  verifyVectors,
} from './smoke-gemini-developer.mjs';

test('a worker crash or kill never becomes a successful diagnostic', () => {
  const rows = [{ status: 'pass' }];
  assert.equal(diagnosticExitCode(rows, 0), 0);
  assert.equal(diagnosticExitCode(rows, 1), 1);
  assert.equal(diagnosticExitCode(rows, null), 1);
  assert.equal(diagnosticExitCode([], 0), 1);
  assert.equal(diagnosticExitCode([{ status: 'blocked' }], 0), 1);
});

test('connection deadline covers a pending handshake and closes late sessions', async () => {
  const controller = new AbortController();
  let resolveConnection;
  let closed = 0;
  const result = connectWithinSignal(
    () =>
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  resolveConnection({
    close: () => {
      closed++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
});

test('already aborted connections never start, successful connections remain open', async () => {
  await assert.rejects(
    connectWithinSignal(() => assert.fail('must not connect'), AbortSignal.abort()),
  );
  const controller = new AbortController();
  const session = { close: () => assert.fail('caller owns successful connection') };
  assert.equal(await connectWithinSignal(async () => session, controller.signal), session);
});

test('import is silent and never starts a network request', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `globalThis.fetch = () => { throw new Error('network_must_not_run'); }; process.argv.push('--run'); await import(${JSON.stringify(new URL('./smoke-gemini-developer.mjs', import.meta.url).href)});`,
    ],
    { env: {}, encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('requires explicit adult synthetic diagnostic opt-in and a pinned model', () => {
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--run', '--model', 'gemini-flash-latest']));
  assert.throws(() => parseArgs(['--run', '--model', 'https://example.org']));
  const opts = parseArgs(['--run', '--model', 'gemini-3.1-flash-lite']);
  assert.equal(opts.model, 'gemini-3.1-flash-lite');
  assert.deepEqual(opts.cases, CASES);
});

test('rejects secret CLI arguments and arbitrary cases', () => {
  assert.throws(() => parseArgs(['--api-key', 'secret']));
  assert.throws(() =>
    parseArgs(['--run', '--model', 'gemini-3.1-flash-lite', '--case', 'arbitrary']),
  );
  assert.deepEqual(
    parseArgs(['--run', '--model', 'gemini-3.1-flash-lite', '--case', 'tool,tool']).cases,
    ['tool'],
  );
});

test('request budget refuses any request beyond its limit', () => {
  const budget = new Budget(2);
  budget.take();
  budget.take();
  assert.equal(budget.used, 2);
  assert.throws(() => budget.take(), /call_budget/);
  assert.equal(budget.used, 2);
});

test('provider errors become fixed categories, never raw messages', () => {
  assert.equal(classify({ status: 429, message: 'secret' }), 'quota_exhausted');
  assert.equal(classify({ status: 404 }), 'model_unavailable');
  assert.equal(classify({ status: 403 }), 'permission_denied');
  assert.equal(classify(new Error('secret')), 'provider_error');
  assert.equal(classify({ name: 'TimeoutError' }), 'timeout');
});

test('IPC reports discard arbitrary keys, model output, errors and audio', () => {
  const row = safeRow({
    case: 'chat',
    status: 'pass',
    category: 'verified',
    durationMs: 32,
    calls: 1,
    tokens: 10,
    audioBytes: 100,
    raw: 'secret',
    apiKey: 'secret',
    text: 'secret',
  });
  assert.equal(JSON.stringify(row).includes('secret'), false);
  assert.equal(row.durationMs, 32);
  assert.equal(row.tokens, 10);
  assert.equal(
    safeRow({ case: 'secret', status: 'pass', category: 'secret' }).category,
    'worker_failed',
  );
  assert.equal(
    safeRow({ case: 'chat', status: 'pass', category: 'quota_exhausted' }).status,
    'blocked',
  );
});

test('tool probe requires observed call, actual execution, response and receipt use', () => {
  assert.equal(verifyReceipt(true, true, 1, 'nonce', 'nonce'), true);
  assert.equal(verifyReceipt(false, true, 1, 'nonce', 'nonce'), false);
  assert.equal(verifyReceipt(true, false, 1, 'nonce', 'nonce'), false);
  assert.equal(verifyReceipt(true, true, 0, 'nonce', 'nonce'), false);
  assert.equal(verifyReceipt(true, true, 1, 'guessed', 'nonce'), false);
});

test('embedding probe requires finite nonzero vectors and correct ranking', () => {
  assert.equal(
    verifyVectors([
      [1, 0],
      [0.9, 0.1],
      [0, 1],
    ]),
    true,
  );
  assert.equal(
    verifyVectors([
      [1, 0],
      [0, 1],
      [0.9, 0.1],
    ]),
    false,
  );
  assert.equal(
    verifyVectors([
      [0, 0],
      [0, 0],
      [0, 0],
    ]),
    false,
  );
  assert.equal(verifyVectors([[NaN], [1], [1]]), false);
  assert.equal(verifyVectors([[1], [1, 0], [1]]), false);
});
