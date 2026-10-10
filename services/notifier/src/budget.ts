import type { Firestore } from '@google-cloud/firestore';
import { VOICE_FLAG_DOC } from '@ijime/agent-core';
import { pilot } from '@ijime/config';
import type { Logger } from '@ijime/service-kit';
import { z } from 'zod';

export const BUDGET_ALERT_PATH = '/internal/events/budget-alert';

// Cloud Billing の予算通知（schema 1.0）。必要なフィールドだけを取り、残りは無視する
export const budgetAlertSchema = z.object({
  costAmount: z.number().nonnegative(),
  budgetAmount: z.number().positive(),
  costIntervalStart: z.string().min(1),
  alertThresholdExceeded: z.number().nonnegative().optional(),
});
export type BudgetAlert = z.infer<typeof budgetAlertSchema>;

export type BudgetDeps = { db: Firestore; logger: Logger; now: () => Date };

// 予算が voiceBreakerThreshold に達したら音声を全体で停止し、新しい請求期間に入ったら自動で復旧する。
// 運用担当者が手動で止めたスイッチ（reason が budget 以外）は自動では開けない。
export async function handleBudgetAlert(deps: BudgetDeps, alert: BudgetAlert): Promise<void> {
  const ratio = Math.max(alert.costAmount / alert.budgetAmount, alert.alertThresholdExceeded ?? 0);
  const period = alert.costIntervalStart;
  const ref = deps.db.doc(VOICE_FLAG_DOC);
  const change = await deps.db.runTransaction(async (tx) => {
    const current = await tx.get(ref);
    const disabled = current.get('disabled') === true;
    const byBudget = current.get('reason') === 'budget';
    if (ratio >= pilot.voiceBreakerThreshold) {
      if (disabled && (!byBudget || current.get('period') === period)) return undefined;
      tx.set(ref, { disabled: true, reason: 'budget', period, updatedAt: deps.now() });
      return 'disabled' as const;
    }
    if (disabled && byBudget && current.get('period') !== period) {
      tx.set(ref, {
        disabled: false,
        reason: 'budget_period_reset',
        period,
        updatedAt: deps.now(),
      });
      return 'enabled' as const;
    }
    return undefined;
  });
  if (change === 'disabled')
    deps.logger.warn('voice.disabled_by_budget', { ratio: Math.round(ratio * 100) / 100 });
  if (change === 'enabled') deps.logger.info('voice.enabled_new_period', {});
}
