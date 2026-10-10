import type { WeeklyReportRes, WeeklyReportsRes } from '@ijime/api-types';
import { isCrisisActive } from '@ijime/config';
import { ApiHttpError, type ServiceApp, type ServiceEnv } from '@ijime/service-kit';
import type { Hono } from 'hono';
import { z } from 'zod';

import { guardianAuth, type GuardianAuthEnv } from '../auth.js';
import { familyOfGuardian, type NotificationRoutesDeps } from './notifications.js';
import { resourceId } from './workflow-store.js';

const weekSchema = z.string().regex(/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/);
const days = z.number().int().min(0).max(7);
const reportSchema = z.object({
  vitality: z.object({
    mood: z.object({ sunny: days, cloudy: days, rainy: days, stormy: days }),
    activeDays: days,
    lateNightDays: days,
  }),
  summaryText: z.string(),
});

export function registerGuardianWeekly(
  app: ServiceApp,
  getDeps: () => Promise<NotificationRoutesDeps>,
): void {
  const r = app as unknown as Hono<GuardianAuthEnv & ServiceEnv>;
  const path = '/v1/children/:childId/weekly-reports';
  r.use(path, async (c, next) => {
    const deps = await getDeps();
    c.header('Cache-Control', 'no-store');
    return guardianAuth(deps.auth, (id) => familyOfGuardian(deps.db, id))(c, next);
  });
  r.get(path, async (c) => {
    const { db } = await getDeps();
    const { familyId, guardianId } = c.get('guardian');
    const childId = resourceId(c.req.param('childId'));
    const week = c.req.query('week');
    const weeksParam = c.req.query('weeks');
    if (week !== undefined && !weekSchema.safeParse(week).success)
      throw new ApiHttpError('INVALID_ARGUMENT', '週を選び直してください');
    const weeks = weeksParam === undefined ? undefined : Number.parseInt(weeksParam, 10);
    if (
      weeksParam !== undefined &&
      (!Number.isInteger(weeks) || weeks! < 1 || weeks! > 12 || week !== undefined)
    )
      throw new ApiHttpError('INVALID_ARGUMENT', '期間を選び直してください');
    const root = db.doc(`families/${familyId}/children/${childId}`);
    const body = await db.runTransaction(
      async (tx): Promise<WeeklyReportRes | WeeklyReportsRes> => {
        const family = await tx.get(db.doc(`families/${familyId}`));
        const guardian = await tx.get(db.doc(`families/${familyId}/guardians/${guardianId}`));
        const role = guardian.get('role');
        const status = guardian.get('status');
        if (
          !guardian.exists ||
          guardian.get('guardianId') !== guardianId ||
          (role !== 'primary' && role !== 'secondary') ||
          guardian.get('revokedAt') != null ||
          (status !== undefined && status !== 'active')
        )
          throw new ApiHttpError('PERMISSION_DENIED', '保護者の情報を利用できません');
        const child = await tx.get(root);
        if (family.exists && family.get('status') !== 'active')
          throw new ApiHttpError('PERMISSION_DENIED', '家族を利用できません');
        if (family.get('consentComplete') !== undefined && family.get('consentComplete') !== true)
          throw new ApiHttpError('CONSENT_REQUIRED', '保護者の同意が必要です');
        if (child.get('status') !== 'active')
          throw new ApiHttpError('NOT_FOUND', 'お子さんが見つかりません');
        const crises = await tx.get(root.collection('crisisEvents'));
        if (
          crises.docs.some(
            (crisis) =>
              isCrisisActive(crisis.data(), new Date()) &&
              crisis.get('familyHarmSuspected') !== false,
          )
        )
          throw new ApiHttpError('NOT_FOUND', 'この週の記録はまだありません');
        const reports = root.collection('weeklyReports');
        if (weeks !== undefined) {
          const snapshots = await tx.get(reports.orderBy('weekStart', 'desc').limit(weeks));
          const items = snapshots.docs
            .filter((report) => weekSchema.safeParse(report.id).success)
            .flatMap((report) => {
              const parsed = reportSchema.safeParse(report.data());
              return parsed.success
                ? [
                    {
                      weekId: report.id,
                      vitality: parsed.data.vitality,
                      summaryText: parsed.data.summaryText,
                    },
                  ]
                : [];
            });
          if (items.length === 0)
            throw new ApiHttpError('NOT_FOUND', 'この期間の記録はまだありません');
          return { items };
        }
        const report = week
          ? await tx.get(reports.doc(week))
          : (await tx.get(reports.orderBy('weekStart', 'desc').limit(1))).docs[0];
        if (!report?.exists) throw new ApiHttpError('NOT_FOUND', 'この週の記録はまだありません');
        const parsed = reportSchema.safeParse(report.data());
        if (!parsed.success || !weekSchema.safeParse(report.id).success)
          throw new Error('invalid_weekly_report');
        return {
          weekId: report.id,
          vitality: parsed.data.vitality,
          summaryText: parsed.data.summaryText,
        };
      },
      { readOnly: true },
    );
    return c.json(body);
  });
}
