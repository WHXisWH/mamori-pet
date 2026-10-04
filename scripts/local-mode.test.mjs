import assert from 'node:assert/strict';
import test from 'node:test';
import { localMode } from './local-mode.mjs';

const approved = { GCP_PROJECT_ID: 'zenn-hackathon-510109', REAL_BUSINESS_APPROVED: '1' };

test('scripted and bounded real modes remain distinct from manual mode', () => {
  assert.equal(localMode([], {}).name, 'scripted');
  assert.deepEqual(localMode(['--real'], approved), {
    name: 'bounded',
    real: true,
    manual: false,
    backend: ['scripts/real-preview.mjs', '--run'],
  });
  assert.deepEqual(localMode(['--manual'], approved), {
    name: 'manual',
    real: true,
    manual: true,
    backend: ['scripts/manual-preview.mjs', '--run'],
  });
});

test('invalid flags, unapproved cloud runs, and production fail before starting processes', () => {
  for (const args of [['--real', '--manual'], ['--manual', '--extra'], ['--wrong']])
    assert.throws(() => localMode(args, approved), /Usage/);
  for (const flag of ['--real', '--manual']) {
    for (const env of [
      {},
      { ...approved, REAL_BUSINESS_APPROVED: '0' },
      { ...approved, GCP_PROJECT_ID: 'other' },
    ])
      assert.throws(() => localMode([flag], env), /explicit test project/);
  }
  assert.throws(
    () => localMode(['--manual'], { ...approved, NODE_ENV: 'production' }),
    /production/,
  );
});
