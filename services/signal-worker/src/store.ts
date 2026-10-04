import type { Firestore } from '@google-cloud/firestore';
import type { DataSource, Domain, GradeBand, SignalScoring } from '@ijime/api-types';
import { retention } from '@ijime/config';
import { signalDefinitionSchema, type Kb, type SignalDefinition } from '@ijime/kb-loader';
import { SkipEvent, stableId } from '@ijime/service-kit';

import { jst, type Metric, type SignalDraft } from './rules.js';
import type { ContextKind } from './evidence.js';

// signals ドキュメントにはテキストのフィールドを一切持たせない
export type SignalDoc = {
  domain: Domain;
  signalDefId: string;
  value: number;
  explicit: boolean;
  scoring: SignalScoring;
  sourceRef: string;
  kbVersion: string;
  extractedBy: string;
  localDate: string;
  createdAt: Date;
  expireAt: Date;
  metric?: Metric;
  contextKind?: ContextKind;
  evidenceMatched?: boolean;
};

export type ChildDoc = {
  familyId: string;
  gradeBand: GradeBand;
  dataSources?: Partial<Record<DataSource, boolean>>;
  status?: string;
};

export const childDocPath = (familyId: string, childId: string) =>
  `families/${familyId}/children/${childId}`;

export async function readChild(
  db: Firestore,
  familyId: string,
  childId: string,
): Promise<ChildDoc | undefined> {
  const child = (await db.doc(childDocPath(familyId, childId)).get()).data() as
    ChildDoc | undefined;
  return child && (!child.status || child.status === 'active') ? child : undefined;
}

export async function loadSignalDefs(kb: Kb): Promise<SignalDefinition[]> {
  const paths = kb.paths('signals/').filter((p) => p.endsWith('.yaml'));
  return Promise.all(paths.map((p) => kb.yaml(p, signalDefinitionSchema)));
}

export function signalId(sourceRef: string, draft: SignalDraft): string {
  return stableId(sourceRef, draft.signalDefId, draft.metric?.name ?? '');
}

// 決定論的な ID と set：重複配信でもまったく同じドキュメントになる
export async function writeSignals(
  db: Firestore,
  input: {
    familyId: string;
    childId: string;
    sourceRef: string;
    occurredAt: Date;
    kbVersion: string;
    extractedBy: string;
    now: Date;
  },
  drafts: readonly SignalDraft[],
): Promise<void> {
  if (drafts.length === 0) return;
  const root = childDocPath(input.familyId, input.childId);
  const base = `${root}/signals`;
  await db.runTransaction(async (tx) => {
    const owner = await tx.get(db.doc(root));
    const source = await tx.get(db.doc(input.sourceRef));
    if (
      !owner.exists ||
      (owner.get('status') && owner.get('status') !== 'active') ||
      !source.exists
    )
      throw new SkipEvent('source_deleted');
    for (const d of drafts) {
      const doc: SignalDoc = {
        domain: d.domain,
        signalDefId: d.signalDefId,
        value: d.value,
        explicit: d.explicit,
        scoring: d.scoring ?? 'score',
        sourceRef: input.sourceRef,
        kbVersion: input.kbVersion,
        extractedBy: input.extractedBy,
        localDate: jst(input.occurredAt).localDate,
        createdAt: input.now,
        expireAt: new Date(input.now.getTime() + retention.signalsDays * 86_400_000),
      };
      if (d.metric) doc.metric = d.metric;
      if (d.contextKind) doc.contextKind = d.contextKind;
      if (d.evidenceMatched !== undefined) doc.evidenceMatched = d.evidenceMatched;
      tx.set(db.doc(`${base}/${signalId(input.sourceRef, d)}`), doc);
    }
  });
}
