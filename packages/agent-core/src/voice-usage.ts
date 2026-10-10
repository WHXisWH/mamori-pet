import { FieldValue, type Firestore } from '@google-cloud/firestore';
import { voice as voiceConfig } from '@ijime/config';

import { childPath } from './child-directory.js';

// 全体の運用フラグ（docs/03 opsFlags）。voice ドキュメントは notifier が予算アラートに応じて書き、api と voice-relay は読むだけ
export const OPS_FLAGS = 'opsFlags';
export const VOICE_FLAG_DOC = `${OPS_FLAGS}/voice`;

const tokyoDate = (now: Date) => new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);

// chatUsage/{date}（会話のターン数。丸ごと上書きされる）とは分けて保存する
export function voiceUsagePath(familyId: string, childId: string, now: Date): string {
  return `${childPath(familyId, childId)}/chatUsage/${tokyoDate(now)}_voice`;
}

export async function voiceDisabled(db: Firestore): Promise<boolean> {
  return (await db.doc(VOICE_FLAG_DOC).get()).get('disabled') === true;
}

export async function remainingVoiceSeconds(
  db: Firestore,
  child: { familyId: string; childId: string },
  now: Date,
  dailyMinutes: number = voiceConfig.dailyMinutesPerChild,
): Promise<number> {
  const used = Number(
    (await db.doc(voiceUsagePath(child.familyId, child.childId, now)).get()).get('seconds') ?? 0,
  );
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  return Math.max(0, dailyMinutes * 60 - safeUsed);
}

export async function addVoiceSeconds(
  db: Firestore,
  child: { familyId: string; childId: string },
  now: Date,
  seconds: number,
): Promise<void> {
  const whole = Math.ceil(seconds);
  if (!(whole > 0)) return;
  await db.doc(voiceUsagePath(child.familyId, child.childId, now)).set(
    {
      seconds: FieldValue.increment(whole),
      expireAt: new Date(now.getTime() + 2 * 86_400_000),
    },
    { merge: true },
  );
}
