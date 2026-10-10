/* global __ENV, open */
// 音声の負荷試験（シナリオ 3）：10 本の WebSocket。インスタンス再起動後の再接続を含む。
//
// 各 VU はチケットを取得 → voice-relay に接続 → start を送信 → ready を受け取ったらリアルタイムの速度で 16 kHz PCM16 の合成音声を送る
// （低音量の正弦波で、人の声は一切含まない）→ SESSION_SECONDS 維持してから stop を送る。
// end を受け取らないまま接続が切れたとき（たとえば負荷試験中に新しいリビジョンをデプロイして旧インスタンスが停止したとき）は、すぐに新しいチケットを取って再接続し、
// 切断から再び ready になるまでの時間を voice_reconnect_ms に記録する。report.mjs は voice.reconnectWindowMs で判定する。
//
// 実際の Live API は分単位で課金される。子ども 1 人につき 1 日 voice.dailyMinutesPerChild の制限がある。
// ローカルプレビューには Live のバックエンドがなく、セッションは end（error）で終わるため、チケット、ハンドシェイク、スクリプト自体の検証しかできない。
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { WebSocket } from 'k6/websockets';

const accounts = JSON.parse(open(__ENV.ACCOUNTS));
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '5m';
const SESSION_SECONDS = Number(__ENV.SESSION_SECONDS || 120);
const SUMMARY = __ENV.SUMMARY || 'voice.summary.json';
const FRAME_MS = 40;
const SAMPLE_RATE = 16000;

export const options = {
  scenarios: {
    voice: { executor: 'constant-vus', vus: VUS, duration: DURATION, gracefulStop: '30s' },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'max'],
};

const readyMs = new Trend('voice_ready_ms', true);
const reconnectMs = new Trend('voice_reconnect_ms', true);
const sessionOk = new Rate('voice_session_ok');
const ticketErrors = new Counter('voice_ticket_errors');
const unexpectedClose = new Counter('voice_unexpected_close');
const ends = new Counter('voice_end');

// 220 Hz、約 -30 dBFS の正弦波。1 フレーム 40 ms（640 サンプル、1280 バイト）
function toneFrame() {
  const samples = (SAMPLE_RATE * FRAME_MS) / 1000;
  const buf = new ArrayBuffer(samples * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples; i++)
    view.setInt16(i * 2, Math.round(1000 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE)), true);
  return buf;
}
const FRAME = toneFrame();

export function setup() {
  if (accounts.children.length < VUS)
    throw new Error(`accounts.json has ${accounts.children.length} children, need >= ${VUS}`);
  return { apiBase: accounts.apiBase, origin: accounts.childOrigin };
}

function ticketFor(apiBase, child) {
  const headers = child.devHeader
    ? { 'X-Dev-Child-Id': child.childId }
    : { Authorization: `Bearer ${child.idToken}` };
  const res = http.post(`${apiBase}/v1/child/voice/tickets`, '{}', {
    headers: { ...headers, 'Content-Type': 'application/json' },
    tags: { name: 'voice_ticket' },
  });
  const ok = res.status === 200 || res.status === 201;
  check(res, { 'ticket issued': () => ok });
  if (!ok) {
    ticketErrors.add(1, { status: String(res.status) });
    // 429（当日の分数を使い切った、1 分あたりのレート制限）または 503（音声が停止中）のときは空回りしない
    sleep(5);
    return null;
  }
  return res.json();
}

// 1 回のセッション：{ ended, reason } を返す。ended=false は接続が予期せず切れたことを示す
function runSession(data, child, disconnectedAt) {
  const ticket = ticketFor(data.apiBase, child);
  if (!ticket) return Promise.resolve({ ended: true, reason: 'ticket_error' });
  return new Promise((resolve) => {
    const opened = Date.now();
    const ws = new WebSocket(`${ticket.wsUrl}?ticket=${encodeURIComponent(ticket.ticket)}`, null, {
      headers: { Origin: data.origin },
    });
    let ready = false;
    let endReason = null;
    let audio = null;
    let stopTimer = null;
    const finish = (result) => {
      if (audio) clearInterval(audio);
      if (stopTimer) clearTimeout(stopTimer);
      resolve(result);
    };
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', sampleRateHz: SAMPLE_RATE }));
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'ready' && !ready) {
        ready = true;
        readyMs.add(Date.now() - opened);
        if (disconnectedAt) reconnectMs.add(Date.now() - disconnectedAt);
        audio = setInterval(() => ws.send(FRAME), FRAME_MS);
        stopTimer = setTimeout(
          () => ws.send(JSON.stringify({ type: 'stop' })),
          SESSION_SECONDS * 1000,
        );
      } else if (message.type === 'end') {
        endReason = message.reason;
        ends.add(1, { reason: String(message.reason) });
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (endReason !== null) {
        sessionOk.add(ready && endReason === 'stop');
        finish({ ended: true, reason: endReason });
      } else {
        unexpectedClose.add(1);
        finish({ ended: false, reason: ready ? 'dropped' : 'closed_before_ready' });
      }
    };
  });
}

export default async function (data) {
  const child = accounts.children[(exec.vu.idInTest - 1) % accounts.children.length];
  let disconnectedAt = null;
  // 予期しない切断のときは最大 3 回続けて再接続する
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await runSession(data, child, disconnectedAt);
    if (result.ended) {
      // セッションが異常終了（error、limit など）したときは少し待ってから次を始め、同じ子どもで続けてチケットを取らないようにする
      if (result.reason !== 'stop') sleep(5);
      return;
    }
    disconnectedAt = Date.now();
  }
  sessionOk.add(false);
  sleep(5);
}

export function handleSummary(data) {
  const m = data.metrics;
  const pick = (name, stat) => (m[name] ? m[name].values[stat] : null);
  const lines = [
    `vus=${VUS} duration=${DURATION} session=${SESSION_SECONDS}s`,
    `session ok rate=${pick('voice_session_ok', 'rate')} ready ms p95=${pick('voice_ready_ms', 'p(95)')}`,
    `reconnect ms max=${pick('voice_reconnect_ms', 'max')} unexpected_close=${pick('voice_unexpected_close', 'count') || 0}`,
    `ticket_errors=${pick('voice_ticket_errors', 'count') || 0} ends=${pick('voice_end', 'count') || 0}`,
  ];
  return {
    stdout: `${lines.join('\n')}\n`,
    [SUMMARY]: JSON.stringify({ kind: 'voice', vus: VUS, duration: DURATION, metrics: m }, null, 2),
  };
}
