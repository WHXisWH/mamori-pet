/* global __ENV */
// ペアリングのレート制限の負荷試験（シナリオ 5）：匿名リクエストで上限を超える速度で POST /v1/child/pair を叩き、
// ランダムな無効のペアリングコードを使う（どの子どもともペアリングされない）。1 分あたりの 429 以外の応答数が全体上限を超えてはならない。
// report.mjs が k6 の JSON 出力を読んで分ごとに集計する（--out json=pairing.ndjson が必要）。
//
// 負荷試験中は実在の家庭もペアリングできなくなる（全体上限が埋まる）ため、dev でだけ実行する。
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const API = __ENV.API_BASE;
const RATE_PER_MINUTE = Number(__ENV.RATE_PER_MINUTE || 300);
const DURATION = __ENV.DURATION || '3m';
const SUMMARY = __ENV.SUMMARY || 'pairing.summary.json';

export const options = {
  scenarios: {
    pairing: {
      executor: 'constant-arrival-rate',
      rate: RATE_PER_MINUTE,
      timeUnit: '1m',
      duration: DURATION,
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'max'],
};

const statuses = new Counter('pairing_status');

function randomCode() {
  let code = '';
  while (code === '' || code === '123456')
    code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return code;
}

export function setup() {
  if (!API) throw new Error('API_BASE is required');
}

export default function () {
  const res = http.post(`${API}/v1/child/pair`, JSON.stringify({ code: randomCode() }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'pair' },
  });
  statuses.add(1, { status: String(res.status) });
  check(res, { 'expected 410 or 429': (r) => r.status === 410 || r.status === 429 });
}

export function handleSummary(data) {
  const m = data.metrics;
  const p95 = m.http_req_duration ? m.http_req_duration.values['p(95)'] : null;
  const checks = m.checks ? m.checks.values.rate : null;
  return {
    stdout: `rate=${RATE_PER_MINUTE}/min duration=${DURATION} expected-status rate=${checks} p95=${p95}ms\n`,
    [SUMMARY]: JSON.stringify(
      { kind: 'pairing', rate: RATE_PER_MINUTE, duration: DURATION, metrics: m },
      null,
      2,
    ),
  };
}
