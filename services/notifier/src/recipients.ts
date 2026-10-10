import type { NotificationKind, NotifyChannel } from '@ijime/api-types';

export type GuardianContact = {
  guardianId: string;
  role?: 'primary' | 'secondary';
  email?: string;
  phoneE164?: string;
  notifyChannels: NotifyChannel[];
  fcmTokens: string[];
};

export type Delivery = { guardianId: string; channels: NotifyChannel[] };

function reachable(g: GuardianContact, ch: NotifyChannel): boolean {
  if (ch === 'webpush') return g.fcmTokens.length > 0;
  if (ch === 'email') return Boolean(g.email);
  return Boolean(g.phoneE164);
}

// 危機：保護者全員に、到達できるすべてのチャネルで送る。個人設定は見ない。それ以外：個人設定に従い、SMS は送らない
export function planDeliveries(
  kind: NotificationKind,
  guardians: readonly GuardianContact[],
  opts: { familyHarmSuspected?: boolean } = {},
): Delivery[] {
  if (kind === 'crisis' && opts.familyHarmSuspected) return [];
  return guardians.map((g) => {
    const wanted: NotifyChannel[] =
      kind === 'crisis' ? ['webpush', 'email', 'sms'] : g.notifyChannels.filter((c) => c !== 'sms');
    return { guardianId: g.guardianId, channels: wanted.filter((c) => reachable(g, c)) };
  });
}

// 危機通知は初回は主保護者にだけ送り、確認がなければ crisis-escalation が第二保護者を加える（2026-10-05 決定）。
// 主保護者が見つからないとき（role のない古いデータ）は、多めに送る側に倒して全保護者に送る
export function firstCrisisRecipients<T extends GuardianContact>(guardians: readonly T[]): T[] {
  const primary = guardians.filter((g) => g.role === 'primary');
  return primary.length > 0 ? primary : [...guardians];
}

export function channelsOf(deliveries: readonly Delivery[]): NotifyChannel[] {
  const all = new Set(deliveries.flatMap((d) => d.channels));
  return (['webpush', 'email', 'sms'] as const).filter((c) => all.has(c));
}
