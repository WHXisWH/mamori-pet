/* global __ENV, open */
// テキスト会話の負荷試験（シナリオ 1、2）。
//
//   SCENARIO=sse40      40 セッションの同時会話（既定 3 分）。api / pet-agent の同時実行とインスタンスのスケールアウトを見る
//   SCENARIO=sustained  実際の Gemini で 5 分間連続。モデルのクォータとレイテンシが安定しているかを見る
//
// k6 の http は SSE 全体を読み切ってから返るため、ここで測るのは 1 ターン全体の時間。最初の文字が見えるまでの時間はサーバー側ログ chat.turn の
// firstVisibleTextMs から得る（scripts/load/report.mjs logs）。meta イベントは危機検知のあとに書き出されるため、
// http_req_waiting は「危機検知 + 保存」の時間にほぼ等しい。
//
// 送るのは中立的な合成テキストだけで、危機検知に引っかかる内容は送らない：危機になると合成の保護者に通知メールが送られる。
// 1 人の子どもは 1 日 agent.dailyTurnLimit ターンまで。accounts.json の子どもの数は VUS 以上にする。
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const accounts = JSON.parse(open(__ENV.ACCOUNTS));
const SCENARIO = __ENV.SCENARIO || 'sse40';
const VUS = Number(__ENV.VUS || 40);
const DURATION = __ENV.DURATION || (SCENARIO === 'sustained' ? '5m' : '3m');
const THINK_SECONDS = Number(__ENV.THINK_SECONDS || 8);
const SUMMARY = __ENV.SUMMARY || `chat-${SCENARIO}.summary.json`;

const TEXTS = [
  'きょうは きゅうしょくに カレーが でたよ',
  'ねこの どうがを みたんだ',
  'さんすうの しゅくだい ちょっと むずかしかった',
  'あしたは えんそくなんだ。はれると いいな',
  'さいきん はまってる ゲームの はなし してもいい？',
  'としょしつで おもしろい ほんを みつけた',
  'たいいくで なわとびを したよ',
  'おやつに なにを たべようかな',
];

export const options = {
  scenarios: {
    chat:
      SCENARIO === 'sustained'
        ? { executor: 'constant-vus', vus: VUS, duration: DURATION, gracefulStop: '90s' }
        : {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
              { duration: '30s', target: VUS },
              { duration: DURATION, target: VUS },
              { duration: '10s', target: 0 },
            ],
            gracefulRampDown: '90s',
          },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'max'],
};

const turnMs = new Trend('chat_turn_ms', true);
const safetyMs = new Trend('chat_safety_ms', true);
const turnOk = new Rate('chat_turn_ok');
const fallback = new Rate('chat_fallback');
const paused = new Rate('chat_paused');
const crisis = new Counter('chat_crisis');
const rateLimited = new Counter('chat_rate_limited');
const sessionErrors = new Counter('chat_session_errors');

export function setup() {
  if (accounts.children.length < VUS)
    throw new Error(`accounts.json has ${accounts.children.length} children, need >= ${VUS}`);
  return { apiBase: accounts.apiBase };
}

function headersFor(child) {
  return child.devHeader
    ? { 'X-Dev-Child-Id': child.childId }
    : { Authorization: `Bearer ${child.idToken}` };
}

export function parseSse(body) {
  const events = [];
  for (const block of String(body || '').split('\n\n')) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) continue;
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) });
    } catch {
      events.push({ event, data: null });
    }
  }
  return events;
}

let sessionId = null;

export default function (data) {
  const child = accounts.children[(exec.vu.idInTest - 1) % accounts.children.length];
  const headers = { ...headersFor(child), 'Content-Type': 'application/json' };

  if (!sessionId) {
    const res = http.post(`${data.apiBase}/v1/child/chat/sessions`, '{}', {
      headers,
      tags: { name: 'chat_session' },
    });
    if (res.status !== 201) {
      sessionErrors.add(1);
      if (res.status === 429) rateLimited.add(1);
      sleep(THINK_SECONDS);
      return;
    }
    sessionId = res.json('sessionId');
  }

  const text = TEXTS[(exec.vu.iterationInScenario + exec.vu.idInTest) % TEXTS.length];
  const res = http.post(
    `${data.apiBase}/v1/child/chat/sessions/${sessionId}/messages`,
    JSON.stringify({
      text,
      inputMode: 'typed',
      clientSentAt: new Date().toISOString(),
      typing: { keyCount: text.length, deleteCount: 0, composeMs: 4000, longPauseCount: 0 },
    }),
    {
      headers: { ...headers, Accept: 'text/event-stream' },
      timeout: '90s',
      tags: { name: 'chat_message' },
    },
  );

  if (res.status === 429) rateLimited.add(1);
  const events = res.status === 200 ? parseSse(res.body) : [];
  const done = events.find((e) => e.event === 'done');
  const hitCrisis = events.some((e) => e.event === 'crisis');
  const replyId = done && done.data ? String(done.data.replyMessageId || '') : '';
  const ok = res.status === 200 && Boolean(done) && !replyId.startsWith('fallback_');

  turnOk.add(ok);
  fallback.add(replyId.startsWith('fallback_'));
  paused.add(replyId.startsWith('paused_'));
  if (hitCrisis) crisis.add(1);
  if (res.status === 200) {
    turnMs.add(res.timings.duration);
    safetyMs.add(res.timings.waiting);
  }
  check(res, {
    'status 200': (r) => r.status === 200,
    'stream finished': () => Boolean(done) || hitCrisis,
  });
  // セッションがセーフモードに入ったら新しいセッションに切り替える
  if (hitCrisis) sessionId = null;
  sleep(THINK_SECONDS);
}

export function handleSummary(data) {
  const m = data.metrics;
  const pick = (name, stat) => (m[name] ? m[name].values[stat] : null);
  const lines = [
    `scenario=${SCENARIO} vus=${VUS} duration=${DURATION}`,
    `turns ok rate=${pick('chat_turn_ok', 'rate')} fallback=${pick('chat_fallback', 'rate')} paused=${pick('chat_paused', 'rate')}`,
    `turn ms med=${pick('chat_turn_ms', 'med')} p95=${pick('chat_turn_ms', 'p(95)')}`,
    `safety(ttfb) ms med=${pick('chat_safety_ms', 'med')} p95=${pick('chat_safety_ms', 'p(95)')}`,
    `rate_limited=${pick('chat_rate_limited', 'count') || 0} session_errors=${pick('chat_session_errors', 'count') || 0} crisis=${pick('chat_crisis', 'count') || 0}`,
  ];
  return {
    stdout: `${lines.join('\n')}\n`,
    [SUMMARY]: JSON.stringify(
      { kind: 'chat', scenario: SCENARIO, vus: VUS, duration: DURATION, metrics: m },
      null,
      2,
    ),
  };
}
