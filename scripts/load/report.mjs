#!/usr/bin/env node
// 負荷試験結果のまとめ。判定の基準値はすべて packages/config（pilot、voice、rateLimit）から取る。
//
//   logs     Cloud Logging から api の chat.turn / crisis.check を読み、初回表示と危機検知の p50 / p95 を計算する
//   job      Cloud Run Job の 1 回の実行の開始・終了時刻を読む
//   pairing  k6 --out json の出力を読み、分ごとに 429 以外のペアリング応答数を数える
//   build    artifacts/load-<run>/ の結果をパイロット目標と突き合わせて report.md に書く
//
// ログにあるのは ID、件数、ミリ秒だけ（service-kit は子どもの入力の記録を禁止している）。ここでもそのフィールドだけを取る。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  REGION,
  ROOT,
  artifactDir,
  googleClient,
  parseArgs,
  percentile,
  readJson,
  requireOption,
  runLabel,
  writeJson,
} from './lib.mjs';

// パイロット目標は packages/config で一度だけ定義する（2026-10-03 決定）
async function loadConfig() {
  const url = pathToFileURL(join(ROOT, 'packages/config/dist/index.js')).href;
  try {
    return await import(url);
  } catch {
    throw new Error('config_not_built: run `pnpm --filter @ijime/config build` first');
  }
}

const stats = (values) => ({
  count: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
});

export function summarizeLogs(entries) {
  const firstToken = [];
  const turn = [];
  const crisisCheck = [];
  let turns = 0;
  let fallbacks = 0;
  let paused = 0;
  for (const entry of entries) {
    const p = entry.jsonPayload ?? {};
    if (p.event === 'chat.turn') {
      turns++;
      if (p.fallback === true) fallbacks++;
      if (Number.isFinite(p.firstVisibleTextMs)) firstToken.push(p.firstVisibleTextMs);
      if (Number.isFinite(p.latencyMs)) turn.push(p.latencyMs);
    } else if (p.event === 'crisis.check') {
      if (Number.isFinite(p.latencyMs)) crisisCheck.push(p.latencyMs);
    } else if (p.event === 'crisis.paused') paused++;
  }
  return {
    firstTokenMs: stats(firstToken),
    turnMs: stats(turn),
    crisisCheckMs: stats(crisisCheck),
    turns,
    fallbackRate: turns ? fallbacks / turns : null,
    paused,
  };
}

// k6 --out json は 1 行 1 オブジェクト。pairing_status の計測点だけを見て、UTC の分（サーバー側 pairing-limiter のウィンドウと同じ）でグループ化する
export function summarizePairing(lines, cap) {
  const minutes = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.type !== 'Point' || row.metric !== 'pairing_status') continue;
    const minute = row.data.time.slice(0, 16);
    const status = row.data.tags?.status ?? 'unknown';
    const m = minutes.get(minute) ?? { minute, admitted: 0, limited: 0, errors: 0 };
    // 410 はリクエストが全体枠を獲得してペアリングコードの検証まで進んだことを示す。429 は全体上限で止められたもの
    if (status === '429') m.limited++;
    else if (status === '410') m.admitted++;
    else m.errors++;
    minutes.set(minute, m);
  }
  const rows = [...minutes.values()].sort((a, b) => a.minute.localeCompare(b.minute));
  return {
    cap,
    minutes: rows,
    maxAdmittedPerMinute: rows.reduce((max, r) => Math.max(max, r.admitted), 0),
    overCap: rows.filter((r) => r.admitted > cap).map((r) => r.minute),
    errors: rows.reduce((sum, r) => sum + r.errors, 0),
  };
}

async function logs(options) {
  const run = runLabel(options);
  const project = requireOption(options, 'project');
  const since = requireOption(options, 'since');
  const until = options.until ?? new Date().toISOString();
  const label = options.label ?? 'chat';
  const google = await googleClient(project);
  const filter = [
    'resource.type="cloud_run_revision"',
    'resource.labels.service_name="api"',
    'jsonPayload.event=("chat.turn" OR "crisis.check" OR "crisis.paused")',
    `timestamp>="${since}"`,
    `timestamp<="${until}"`,
  ].join(' AND ');
  const entries = [];
  let pageToken;
  do {
    const page = await google('https://logging.googleapis.com/v2/entries:list', {
      method: 'POST',
      body: { resourceNames: [`projects/${project}`], filter, pageSize: 1000, pageToken },
    });
    entries.push(...(page.entries ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  const summary = { label, since, until, ...summarizeLogs(entries) };
  writeJson(join(artifactDir(run), `logs-${label}.json`), summary);
  console.log(JSON.stringify(summary));
}

async function job(options) {
  const run = runLabel(options);
  const project = requireOption(options, 'project');
  const execution = requireOption(options, 'execution');
  const jobName = options.job ?? 'risk-engine-daily';
  const google = await googleClient(project);
  const e = await google(
    `https://run.googleapis.com/v2/projects/${project}/locations/${REGION}/jobs/${jobName}/executions/${execution}`,
  );
  const start = e.startTime ? Date.parse(e.startTime) : null;
  const end = e.completionTime ? Date.parse(e.completionTime) : null;
  const summary = {
    job: jobName,
    execution,
    children: options.children ? Number(options.children) : null,
    taskCount: e.taskCount ?? null,
    succeeded: e.succeededCount ?? 0,
    failed: e.failedCount ?? 0,
    durationMinutes: start && end ? (end - start) / 60_000 : null,
  };
  writeJson(join(artifactDir(run), 'job.json'), summary);
  console.log(JSON.stringify(summary));
}

async function pairing(options) {
  const run = runLabel(options);
  const file = requireOption(options, 'file');
  const { rateLimit } = await loadConfig();
  const summary = summarizePairing(
    readFileSync(file, 'utf8').split('\n'),
    rateLimit.childRequestsPerMinute,
  );
  writeJson(join(artifactDir(run), 'pairing.json'), summary);
  console.log(JSON.stringify({ ...summary, minutes: summary.minutes.length }));
  if (summary.overCap.length > 0) process.exitCode = 1;
}

const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(2)}%`);
const verdict = (value, limit) =>
  value === null || value === undefined ? '未計測' : value <= limit ? '達成' : '未達成';

function metric(summary, name, stat) {
  return summary?.metrics?.[name]?.values?.[stat] ?? null;
}

export function buildReport({ run, inputs, pilot, voice, monthlyCostJpy }) {
  const out = [
    `# 負荷試験レポート load-${run}`,
    '',
    `生成日時：${new Date().toISOString()}。合成アカウントと合成テキストだけを使用。`,
    '',
  ];
  out.push('## パイロット目標との比較', '', '| 指標 | 実測 | 目標 | 結論 |', '| --- | --- | --- | --- |');
  for (const label of ['sse40', 'sustained']) {
    const l = inputs[`logs-${label}`];
    if (!l) continue;
    out.push(
      `| 初回表示 p50（${label}） | ${ms(l.firstTokenMs.p50)} | ≤ ${pilot.firstTokenP50Ms} ms | ${verdict(l.firstTokenMs.p50, pilot.firstTokenP50Ms)} |`,
      `| 初回表示 p95（${label}） | ${ms(l.firstTokenMs.p95)} | ≤ ${pilot.firstTokenP95Ms} ms | ${verdict(l.firstTokenMs.p95, pilot.firstTokenP95Ms)} |`,
      `| 危機検知 p95（${label}） | ${ms(l.crisisCheckMs.p95)} | ≤ ${pilot.crisisCheckP95Ms} ms | ${verdict(l.crisisCheckMs.p95, pilot.crisisCheckP95Ms)} |`,
    );
  }
  for (const label of ['sse40', 'sustained']) {
    const k = inputs[`chat-${label}.summary`];
    if (!k) continue;
    const okRate = metric(k, 'chat_turn_ok', 'rate');
    const errorRate = okRate === null ? null : 1 - okRate;
    out.push(
      `| 会話の失敗率（${label}、フォールバック応答と 429 を含む） | ${pct(errorRate)} | ≤ ${pct(1 - pilot.chatAvailability)} | ${verdict(errorRate, 1 - pilot.chatAvailability)} |`,
    );
  }
  const v = inputs['voice.summary'];
  if (v) {
    const reconnect = metric(v, 'voice_reconnect_ms', 'max');
    out.push(
      `| 音声の再接続の最長時間（切断から再び ready まで） | ${ms(reconnect)} | ≤ ${voice.reconnectWindowMs} ms | ${verdict(reconnect, voice.reconnectWindowMs)} |`,
    );
  }
  const j = inputs.job;
  if (j)
    out.push(
      `| 日次ジョブの所要時間（子ども ${j.children ?? '?'} 人、task ${j.taskCount ?? '?'} 個） | ${j.durationMinutes === null ? '—' : `${j.durationMinutes.toFixed(1)} 分`} | ≤ ${pilot.dailyJobMaxMinutes} 分 | ${verdict(j.durationMinutes, pilot.dailyJobMaxMinutes)} |`,
    );
  const p = inputs.pairing;
  if (p)
    out.push(
      `| ペアリングの 1 分あたり最大通過数 | ${p.maxAdmittedPerMinute} | ≤ ${p.cap} | ${p.overCap.length === 0 && p.errors === 0 ? '達成' : '未達成'} |`,
    );
  if (monthlyCostJpy !== undefined) {
    const perChild = monthlyCostJpy / pilot.children;
    out.push(
      `| 子ども 1 人あたりの月額コスト（月額費用 ${monthlyCostJpy} 円 / 子ども ${pilot.children} 人） | ${perChild.toFixed(0)} 円 | ≤ ${pilot.costPerChildMonthJpy} 円 | ${verdict(perChild, pilot.costPerChildMonthJpy)} |`,
    );
  }
  out.push('', '## 詳細', '');
  for (const label of ['sse40', 'sustained']) {
    const k = inputs[`chat-${label}.summary`];
    if (!k) continue;
    out.push(
      `- 会話 ${label}：${k.vus} セッション、${k.duration}。ターン全体 p95 ${ms(metric(k, 'chat_turn_ms', 'p(95)'))}。フォールバック ${pct(metric(k, 'chat_fallback', 'rate'))}。保留して再審査 ${pct(metric(k, 'chat_paused', 'rate'))}。429 ${metric(k, 'chat_rate_limited', 'count') ?? 0} 回`,
    );
  }
  if (v)
    out.push(
      `- 音声：${v.vus} セッション、${v.duration}。セッション成功率 ${pct(metric(v, 'voice_session_ok', 'rate'))}。ready p95 ${ms(metric(v, 'voice_ready_ms', 'p(95)'))}。予期しない切断 ${metric(v, 'voice_unexpected_close', 'count') ?? 0} 回。チケット失敗 ${metric(v, 'voice_ticket_errors', 'count') ?? 0} 回`,
    );
  if (p)
    out.push(
      `- ペアリング：${p.minutes.length} 分、想定外のステータスコード ${p.errors} 回、上限超過の分 ${p.overCap.length ? p.overCap.join('、') : 'なし'}`,
    );
  if (monthlyCostJpy === undefined)
    out.push(
      '- コスト：`--monthly-cost-jpy` が未指定。請求レポートにある負荷試験当月の実際の費用（または負荷試験期間の費用から換算した月額費用）で build を再実行する。',
    );
  out.push('');
  return out.join('\n');
}

async function build(options) {
  const run = runLabel(options);
  const dir = artifactDir(run);
  const names = [
    'logs-sse40',
    'logs-sustained',
    'chat-sse40.summary',
    'chat-sustained.summary',
    'voice.summary',
    'job',
    'pairing',
  ];
  const inputs = {};
  for (const name of names) {
    const file = join(dir, `${name}.json`);
    if (existsSync(file)) inputs[name] = readJson(file);
  }
  const { pilot, voice } = await loadConfig();
  const report = buildReport({
    run,
    inputs,
    pilot,
    voice,
    ...(options['monthly-cost-jpy'] ? { monthlyCostJpy: Number(options['monthly-cost-jpy']) } : {}),
  });
  const file = join(dir, 'report.md');
  writeFileSync(file, report);
  console.log(file);
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const commands = { logs, job, pairing, build };
  if (!commands[command]) {
    console.error('usage: node scripts/load/report.mjs <logs|job|pairing|build> --run R ...');
    process.exitCode = 2;
    return;
  }
  await commands[command](options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
