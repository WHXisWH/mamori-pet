import assert from 'node:assert/strict';
import test from 'node:test';

import { localAccounts } from './accounts.mjs';
import { addDays, parseArgs, percentile, runLabel } from './lib.mjs';
import { buildReport, summarizeLogs, summarizePairing } from './report.mjs';
import { syntheticIds, syntheticSignals } from './seed-daily.mjs';

const PILOT = {
  children: 500,
  firstTokenP50Ms: 2500,
  firstTokenP95Ms: 6000,
  crisisCheckP95Ms: 10000,
  chatAvailability: 0.995,
  dailyJobMaxMinutes: 30,
  costPerChildMonthJpy: 150,
};

test('parseArgs reads flags with and without values', () => {
  assert.deepEqual(parseArgs(['seed', '--count', '5', '--run=a1', '--no-bigquery']), {
    command: 'seed',
    options: { count: '5', run: 'a1', 'no-bigquery': true },
  });
  assert.throws(() => parseArgs(['seed', 'stray']), /invalid_arguments/);
});

test('runLabel only accepts labels safe for document IDs and emails', () => {
  assert.equal(runLabel({ run: 'r-1' }), 'r-1');
  assert.throws(() => runLabel({ run: 'Bad/Label' }), /invalid_arguments/);
});

test('percentile uses nearest rank and ignores non-numbers', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([null, Number.NaN], 50), null);
});

test('addDays crosses month ends', () => {
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
});

test('local accounts use dev fixture IDs the api auto-provisions', () => {
  const accounts = localAccounts({
    run: 'r-1',
    count: 2,
    api: 'http://x',
    childOrigin: 'http://o',
  });
  assert.deepEqual(
    accounts.children.map((c) => c.childId),
    ['c_load_r_1_0', 'c_load_r_1_1'],
  );
  assert.ok(
    accounts.children.every((c) => /^c_[a-zA-Z0-9_-]{1,62}$/.test(c.childId) && c.devHeader),
  );
});

test('synthetic children and signals are clearly marked and use rule metrics only', () => {
  assert.deepEqual(syntheticIds('r-1', 3), {
    familyId: 'f_load_r_1_3',
    childId: 'c_load_r_1_3',
    pseudoId: 'p_load_r_1_3',
  });
  const signals = syntheticSignals('2026-10-04', 0, 6);
  assert.equal(signals.length, 6);
  assert.ok(signals.every((s) => s.localDate === '2026-10-04' && s.metric && !s.explicit));
  assert.deepEqual([...new Set(signals.map((s) => s.metric.name))].sort(), [
    'a_valence',
    'i_message_hour',
    'k_delete_ratio',
  ]);
});

test('summarizeLogs takes only timings and counts', () => {
  const summary = summarizeLogs([
    {
      jsonPayload: {
        event: 'chat.turn',
        firstVisibleTextMs: 1000,
        latencyMs: 3000,
        fallback: false,
      },
    },
    {
      jsonPayload: {
        event: 'chat.turn',
        firstVisibleTextMs: 3000,
        latencyMs: 5000,
        fallback: true,
      },
    },
    { jsonPayload: { event: 'crisis.check', latencyMs: 400 } },
    { jsonPayload: { event: 'crisis.paused' } },
  ]);
  assert.deepEqual(summary.firstTokenMs, { count: 2, p50: 1000, p95: 3000 });
  assert.equal(summary.crisisCheckMs.p95, 400);
  assert.equal(summary.fallbackRate, 0.5);
  assert.equal(summary.paused, 1);
});

test('summarizePairing groups admitted responses by minute and flags minutes over the cap', () => {
  const point = (time, status) =>
    JSON.stringify({
      type: 'Point',
      metric: 'pairing_status',
      data: { time, value: 1, tags: { status } },
    });
  const lines = [
    point('2026-10-05T10:00:01.000Z', '410'),
    point('2026-10-05T10:00:02.000Z', '410'),
    point('2026-10-05T10:00:03.000Z', '429'),
    point('2026-10-05T10:01:00.000Z', '410'),
    point('2026-10-05T10:01:01.000Z', '503'),
    JSON.stringify({ type: 'Point', metric: 'http_reqs', data: { time: 'x', value: 1, tags: {} } }),
    '',
  ];
  const summary = summarizePairing(lines, 1);
  assert.equal(summary.maxAdmittedPerMinute, 2);
  assert.deepEqual(summary.overCap, ['2026-10-05T10:00']);
  assert.equal(summary.errors, 1);
});

test('buildReport compares measurements with pilot targets from config', () => {
  const report = buildReport({
    run: 'r-1',
    pilot: PILOT,
    voice: { reconnectWindowMs: 5000 },
    monthlyCostJpy: 60000,
    inputs: {
      'logs-sse40': {
        firstTokenMs: { count: 10, p50: 2000, p95: 7000 },
        crisisCheckMs: { count: 10, p50: 300, p95: 900 },
      },
      'chat-sse40.summary': {
        vus: 40,
        duration: '3m',
        metrics: { chat_turn_ok: { values: { rate: 0.999 } } },
      },
      'voice.summary': {
        vus: 10,
        duration: '5m',
        metrics: { voice_reconnect_ms: { values: { max: 4200 } } },
      },
      job: { children: 500, taskCount: 2, durationMinutes: 12.5 },
      pairing: { cap: 60, maxAdmittedPerMinute: 60, overCap: [], errors: 0, minutes: [{}, {}] },
    },
  });
  assert.match(report, /初回表示 p50（sse40） \| 2000 ms \| ≤ 2500 ms \| 達成/);
  assert.match(report, /初回表示 p95（sse40） \| 7000 ms \| ≤ 6000 ms \| 未達成/);
  assert.match(report, /音声の再接続の最長時間.*4200 ms.*達成/);
  assert.match(report, /日次ジョブの所要時間.*12\.5 分.*達成/);
  assert.match(report, /ペアリングの 1 分あたり最大通過数 \| 60 \| ≤ 60 \| 達成/);
  assert.match(report, /子ども 1 人あたりの月額コスト.*120 円.*達成/);
});
