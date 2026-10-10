import {
  createServiceApp,
  eventSchemas,
  registerPushHandler,
  registerTaskHandler,
  type Logger,
  type ServiceApp,
} from '@ijime/service-kit';

import { BUDGET_ALERT_PATH, budgetAlertSchema, handleBudgetAlert } from './budget.js';
import {
  CONSULTATION_TIMEOUT_PATH,
  consultationTimeoutSchema,
  handleConsultationResolved,
  handleConsultationTimeout,
} from './consultation.js';
import {
  ESCALATION_TASK_PATH,
  escalationTaskSchema,
  handleCrisisDetected,
  handleEscalation,
} from './crisis.js';
import { handleSendTask, SEND_TASK_PATH, sendTaskSchema } from './delivery.js';
import type { NotifierDeps } from './deps.js';
import { runWeeklyReport, WEEKLY_REPORT_PATH, weeklyJobSchema } from './weekly.js';

export const SERVICE_NAME = 'notifier';

export function createApp(getDeps?: () => Promise<NotifierDeps>, logger?: Logger): ServiceApp {
  const app = createServiceApp({
    name: SERVICE_NAME,
    version: process.env['SERVICE_VERSION'] ?? '0.1.0',
    ...(logger ? { logger } : {}),
  });
  if (!getDeps) return app;
  let ready: Promise<NotifierDeps> | undefined;
  const deps = () => (ready ??= getDeps());

  registerPushHandler(
    app,
    '/internal/events/crisis-detected',
    eventSchemas['crisis.detected'],
    async (ev) => handleCrisisDetected(await deps(), ev),
  );
  registerTaskHandler(app, SEND_TASK_PATH, sendTaskSchema, async (t) =>
    handleSendTask(await deps(), t),
  );
  registerTaskHandler(app, ESCALATION_TASK_PATH, escalationTaskSchema, async (t) =>
    handleEscalation(await deps(), t),
  );
  registerPushHandler(
    app,
    '/internal/events/consultation-resolved',
    eventSchemas['consultation.resolved'],
    async (ev) => handleConsultationResolved(await deps(), ev),
  );
  registerTaskHandler(app, CONSULTATION_TIMEOUT_PATH, consultationTimeoutSchema, async (t) =>
    handleConsultationTimeout(await deps(), t),
  );
  registerTaskHandler(app, WEEKLY_REPORT_PATH, weeklyJobSchema, async (job) =>
    runWeeklyReport(await deps(), job),
  );
  registerPushHandler(app, BUDGET_ALERT_PATH, budgetAlertSchema, async (alert) =>
    handleBudgetAlert(await deps(), alert),
  );
  return app;
}
