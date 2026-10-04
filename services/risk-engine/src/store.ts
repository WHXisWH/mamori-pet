import type { Firestore } from '@google-cloud/firestore';
import type { Domain, RiskLevel } from '@ijime/api-types';

import { isHigher, type ExplicitSignal, type Explanation } from './levels.js';

export type ChildState = {
  childId: string;
  familyId: string;
  currentRiskLevel: RiskLevel;
  baselineReadyAt?: Date;
};

export const childDocPath = (familyId: string, childId: string) =>
  `families/${familyId}/children/${childId}`;

export async function findChild(db: Firestore, childId: string): Promise<ChildState | undefined> {
  const snap = await db.collectionGroup('children').where('childId', '==', childId).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return undefined;
  const d = doc.data() as {
    familyId?: string;
    currentRiskLevel?: RiskLevel;
    baselineReadyAt?: { toDate(): Date };
  };
  const out: ChildState = {
    childId,
    familyId: d.familyId ?? doc.ref.parent.parent!.id,
    currentRiskLevel: d.currentRiskLevel ?? 'l0',
  };
  if (d.baselineReadyAt) out.baselineReadyAt = d.baselineReadyAt.toDate();
  return out;
}

export async function explicitSignalsOn(
  db: Firestore,
  child: ChildState,
  localDate: string,
): Promise<ExplicitSignal[]> {
  const snap = await db
    .collection(`${childDocPath(child.familyId, child.childId)}/signals`)
    .where('localDate', '==', localDate)
    .where('explicit', '==', true)
    .get();
  return snap.docs.map((d) => d.data() as ExplicitSignal);
}

export type AssessmentDoc = {
  level: RiskLevel;
  previousLevel: RiskLevel;
  trigger: 'daily' | 'event';
  domainsFlagged: Domain[];
  persistenceDays: Record<string, number>;
  inColdStart: boolean;
  rulesVersion: string;
  explanation: Explanation;
  computedAt: Date;
};

export type ConsultationDoc = {
  assessmentId: string;
  level: RiskLevel;
  offeredAt: Date;
  offerCount: number;
  choice?: string;
};

export type CommitResult = {
  created: boolean;
  previousLevel: RiskLevel;
  consultationId?: string;
};

// 評価、子どものレベル、相談を1つのトランザクションで書き込む：同じ assessmentId は1回だけ有効になり、未完了の相談は同時に1件だけ
export async function commitAssessment(
  db: Firestore,
  child: ChildState,
  assessmentId: string,
  doc: Omit<AssessmentDoc, 'previousLevel'>,
  consult: { consultationId: string; now: Date } | undefined,
): Promise<CommitResult> {
  const base = childDocPath(child.familyId, child.childId);
  const aRef = db.doc(`${base}/riskAssessments/${assessmentId}`);
  const cRef = db.doc(base);
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(aRef);
    const childSnap = await tx.get(cRef);
    const open = consult
      ? (
          await tx.get(
            db.collection(`${base}/consultations`).orderBy('offeredAt', 'desc').limit(10),
          )
        ).docs.find((d) => {
          const c = d.data() as ConsultationDoc;
          return !c.choice && (c.level === 'l2' || c.level === 'l3');
        })
      : undefined;
    if (existing.exists) {
      const prev = (existing.data() as AssessmentDoc).previousLevel;
      const raised = isHigher(doc.level, prev);
      return {
        created: false,
        previousLevel: prev,
        ...(consult && raised ? { consultationId: open?.id ?? consult.consultationId } : {}),
      };
    }
    const previousLevel = ((childSnap.data() as { currentRiskLevel?: RiskLevel } | undefined)
      ?.currentRiskLevel ?? 'l0') as RiskLevel;
    tx.create(aRef, { ...doc, previousLevel });
    tx.update(cRef, { currentRiskLevel: doc.level, careFlag: doc.level !== 'l0' });
    let consultationId: string | undefined;
    // レベルが上がったときだけ相談を始める
    if (consult && isHigher(doc.level, previousLevel)) {
      if (open) {
        consultationId = open.id;
        if ((open.data() as ConsultationDoc).level !== doc.level)
          tx.update(open.ref, { level: doc.level, assessmentId });
      } else {
        consultationId = consult.consultationId;
        const c: ConsultationDoc = {
          assessmentId,
          level: doc.level,
          offeredAt: consult.now,
          offerCount: 0,
        };
        tx.create(db.doc(`${base}/consultations/${consultationId}`), c);
      }
    }
    return { created: true, previousLevel, ...(consultationId ? { consultationId } : {}) };
  });
}
