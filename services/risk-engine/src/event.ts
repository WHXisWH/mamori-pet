import type { RiskLevel } from '@ijime/api-types';
import { consultation as consultConfig } from '@ijime/config';
import { riskRulesSchema } from '@ijime/kb-loader';
import { SkipEvent, stableId, type EventPayload } from '@ijime/service-kit';

import { jstDate } from './daily/calendar.js';
import type { RiskEngineDeps } from './deps.js';
import { explicitL3, isHigher } from './levels.js';
import { isScoredSignal, loadSignalDefs, scoringOf } from './scoring.js';
import {
  commitAssessment,
  explicitSignalsOn,
  findChild,
  type ChildState,
  type CommitResult,
} from './store.js';

export const CONSULTATION_TIMEOUT_PATH = '/internal/tasks/consultation-timeout';
export const RULES_PATH = 'rules/risk_rules.yaml';

export function inColdStart(child: ChildState, now: Date): boolean {
  return !child.baselineReadyAt || child.baselineReadyAt.getTime() > now.getTime();
}

// イベントモード：「明確な発言」のルールだけですぐにレベルを判定し、日次ジョブを待たない
export async function handleAssess(
  deps: RiskEngineDeps,
  ev: EventPayload<'signal.extracted'>,
): Promise<void> {
  if (!ev.explicit) return;
  const { db, kb, logger } = deps;
  const child = await findChild(db, ev.childId);
  if (!child) throw new SkipEvent('child_not_found');
  const now = deps.now();
  const localDate = jstDate(now);
  const rules = await kb.yaml(RULES_PATH, riskRulesSchema);
  const scoring = scoringOf(await loadSignalDefs(kb));
  const explicit = (await explicitSignalsOn(db, child, localDate)).filter((s) =>
    isScoredSignal(s, scoring),
  );
  const verdict = explicitL3(explicit, rules);
  if (!verdict.hit) return;

  const assessmentId = `event-${stableId(ev.childId, localDate, 'explicit')}`;
  // すでに L3 のときも同じ処理を通す：リトライ時に、決定論的な assessmentId を頼りにイベントと期限タスクを送り直す
  const alreadyHigher = isHigher(child.currentRiskLevel, 'l3');
  const result = alreadyHigher
    ? undefined
    : await commitAssessment(
        db,
        child,
        assessmentId,
        {
          level: 'l3',
          trigger: 'event',
          domainsFlagged: verdict.domains,
          persistenceDays: {},
          inColdStart: inColdStart(child, now),
          rulesVersion: kb.version,
          explanation: { domains: verdict.domains, days: 1, explicit: true },
          computedAt: now,
        },
        { consultationId: `consult-${stableId(assessmentId)}`, now },
      );
  if (!result) {
    logger.info('risk.event_no_change', { current: child.currentRiskLevel });
    return;
  }
  await respond(deps, child, assessmentId, 'l3', result);
  logger.warn('risk.level_raised', {
    assessmentId,
    from: result.previousLevel,
    to: 'l3',
    trigger: 'event',
    created: result.created,
  });
}

// コミット後の後続処理。リトライ時にはもう一度実行され、決定論的な ID で重複を防ぐ
export async function respond(
  deps: RiskEngineDeps,
  child: ChildState,
  assessmentId: string,
  to: RiskLevel,
  result: CommitResult,
): Promise<void> {
  if (result.previousLevel !== to) {
    await deps.publisher.publish('risk.level_changed', {
      childId: child.childId,
      assessmentId,
      from: result.previousLevel,
      to,
    });
  }
  if (result.consultationId && to === 'l3') {
    await deps.tasks.enqueue({
      queue: 'consultation-timeout',
      url: `${deps.notifierUrl}${CONSULTATION_TIMEOUT_PATH}`,
      body: {
        familyId: child.familyId,
        childId: child.childId,
        consultationId: result.consultationId,
      },
      delaySeconds: consultConfig.l3NoAnswerHours * 3600,
      taskId: `ctimeout-${stableId(result.consultationId)}`,
    });
  }
}

// 危機イベントでは L4 の評価を1件書き込む。解除は、危機のクローズ後に日次ジョブがルールに従って再計算する
export async function handleCrisis(
  deps: RiskEngineDeps,
  ev: EventPayload<'crisis.detected'>,
): Promise<void> {
  const { db, kb, logger } = deps;
  const child = await findChild(db, ev.childId);
  if (!child) throw new SkipEvent('child_not_found');
  const now = deps.now();
  const assessmentId = `crisis-${stableId(ev.childId, ev.crisisId)}`;
  const result = await commitAssessment(
    db,
    child,
    assessmentId,
    {
      level: 'l4',
      trigger: 'event',
      domainsFlagged: [],
      persistenceDays: {},
      inColdStart: inColdStart(child, now),
      rulesVersion: kb.version,
      explanation: { domains: [], days: 0, crisis: true },
      computedAt: now,
    },
    undefined,
  );
  await respond(deps, child, assessmentId, 'l4', result);
  logger.warn('risk.level_raised', {
    assessmentId,
    from: result.previousLevel,
    to: 'l4',
    trigger: 'crisis',
    created: result.created,
  });
}
