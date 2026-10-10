import { crisis } from './values.js';

// 危機イベントがまだ進行中かどうか（docs/04-backend-api.md「危機対応経路とエラーコード」手順6。2026-10-10 決定）。
// open と状態不明のイベントはすべて進行中とみなす。保護者または子どもの確認から crisis.autoCloseAfterAckHours 時間が経てば終了とみなす。
// 家庭内危害のイベントは子どもの代わりに確認できる人がいないため、検知から crisis.familyHarmAutoCloseDays 日が経っても終了とみなす。
// 状態を closed に書き換えるのはリスクエンジンの日次ジョブ。各サービスはこの1つの判定を使い、読み取り時点で効くので、ジョブが動いているかどうかに依存しない。
export type CrisisEventLike = {
  status?: unknown;
  timeline?: unknown;
  familyHarmSuspected?: unknown;
  createdAt?: unknown;
};

/** まだ進行中の可能性がある状態。Firestore の status in クエリはこの一覧を使い、新しい状態の取りこぼしを防ぐ。 */
export const ACTIVE_CRISIS_STATUSES = ['open', 'guardian_acknowledged', 'child_acknowledged'];

const ACKNOWLEDGED_STATUSES = new Set(['guardian_acknowledged', 'child_acknowledged']);
const ACK_STEPS = new Set(['guardian_acknowledged', 'child_acknowledged']);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type TimestampLike = { toDate(): Date };

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (value && typeof (value as TimestampLike).toDate === 'function')
    return (value as TimestampLike).toDate();
  return undefined;
}

/** 最初の確認（保護者または子ども）の時刻。ここから24時間を数える。 */
export function crisisAcknowledgedAt(event: CrisisEventLike): Date | undefined {
  if (!Array.isArray(event.timeline)) return undefined;
  let first: Date | undefined;
  for (const entry of event.timeline as Array<{ step?: unknown; at?: unknown } | null>) {
    if (!ACK_STEPS.has(entry?.step as string)) continue;
    const at = toDate(entry?.at);
    if (at && (!first || at < first)) first = at;
  }
  return first;
}

function familyHarmExpired(event: CrisisEventLike, now: Date): boolean {
  if (event.familyHarmSuspected !== true) return false;
  const createdAt = toDate(event.createdAt);
  // 検知時刻が読めなければ進行中として扱う（fail closed）
  if (!createdAt) return false;
  return now.getTime() - createdAt.getTime() >= crisis.familyHarmAutoCloseDays * DAY_MS;
}

export function isCrisisActive(event: CrisisEventLike, now: Date): boolean {
  if (event.status === 'closed') return false;
  if (!ACKNOWLEDGED_STATUSES.has(event.status as string)) return !familyHarmExpired(event, now);
  const acknowledgedAt = crisisAcknowledgedAt(event);
  // 確認時刻が読めなければ進行中として扱う（fail closed）
  if (!acknowledgedAt) return true;
  return now.getTime() - acknowledgedAt.getTime() < crisis.autoCloseAfterAckHours * HOUR_MS;
}

/**
 * イベントがまだ子どもをセーフモード画面にとどめるべきか（チャット、大人に伝える、ペットのお願い、音声をすべてロックする）。
 * 子ども自身が「いまは安全」と確認したらすぐに解除する。保護者向けの安全判定（代わりに伝える、週次レポート、通知）は isCrisisActive に従ってさらに24時間守る。
 */
export function isCrisisLockingChild(event: CrisisEventLike, now: Date): boolean {
  return isCrisisActive(event, now) && event.status !== 'child_acknowledged';
}
