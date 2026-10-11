import type { PairingCodeRes } from '@ijime/api-types';

// 発行したペアリング番号を期限まで端末内に残す。ホームへ戻って来ても再発行せずに済む。
// 番号は 10 分・1 回限りで、保護者本人の端末のセッションにしか残らない。
const KEY = 'mamori-pairing';

type Stored = Record<string, PairingCodeRes>;

function readAll(): Stored {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stored) : {};
  } catch {
    return {};
  }
}

export function savePairing(childId: string, pairing: PairingCodeRes): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...readAll(), [childId]: pairing }));
  } catch {
    // 保存できなくても発行自体は済んでいる
  }
}

/** 期限内の番号だけ返す。 */
export function loadPairing(childId: string, now = Date.now()): PairingCodeRes | undefined {
  const pairing = readAll()[childId];
  if (!pairing || Date.parse(pairing.expiresAt) <= now) return undefined;
  return pairing;
}

export function clearPairing(childId: string): void {
  try {
    const all = readAll();
    delete all[childId];
    sessionStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // nothing to clear
  }
}
