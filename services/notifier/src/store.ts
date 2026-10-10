import { FieldValue, type Firestore } from '@google-cloud/firestore';
import type {
  GradeBand,
  HelpResource,
  NotificationKind,
  NotifyChannel,
  NotifyStatus,
  RiskLevel,
} from '@ijime/api-types';

import type { GuardianContact } from './recipients.js';

export type ChildInfo = {
  childId: string;
  familyId: string;
  nickname: string;
  gradeBand: GradeBand;
};

export type NotificationPayload = {
  title: string;
  changes: string[];
  meaning: string;
  suggestions: { try: string[]; avoid: string[] };
  childSummary: string | null;
  resources: HelpResource[];
  reason: { domains: string[]; days: number };
};

export type Attempt = {
  guardianId: string;
  channel: NotifyChannel;
  round: number;
  at: Date;
  result: 'sent' | 'no_target' | 'rejected';
};

export type NotificationDoc = {
  childId: string;
  recipientIds: string[];
  kind: NotificationKind;
  level: RiskLevel;
  templateId: string;
  payload: NotificationPayload;
  channels: NotifyChannel[];
  status: NotifyStatus;
  attempts: Attempt[];
  acknowledgedAt?: Date;
  acknowledgedBy?: string;
  createdAt: Date;
};

export const childDocPath = (familyId: string, childId: string) =>
  `families/${familyId}/children/${childId}`;
export const crisisPath = (familyId: string, childId: string, crisisId: string) =>
  `${childDocPath(familyId, childId)}/crisisEvents/${crisisId}`;
export const notificationPath = (familyId: string, notificationId: string) =>
  `families/${familyId}/notifications/${notificationId}`;

export async function findChild(db: Firestore, childId: string): Promise<ChildInfo | undefined> {
  const snap = await db.collectionGroup('children').where('childId', '==', childId).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) return undefined;
  const d = doc.data() as { familyId?: string; nickname: string; gradeBand: GradeBand };
  return {
    childId,
    familyId: d.familyId ?? doc.ref.parent.parent!.id,
    nickname: d.nickname,
    gradeBand: d.gradeBand,
  };
}

type GuardianDoc = {
  role?: unknown;
  status?: unknown;
  revokedAt?: unknown;
  email?: string;
  phoneE164?: string;
  notifyChannels?: NotifyChannel[];
};

export async function listGuardians(db: Firestore, familyId: string): Promise<GuardianContact[]> {
  const [guardians, devices] = await Promise.all([
    db.collection(`families/${familyId}/guardians`).get(),
    db.collection(`families/${familyId}/devices`).where('ownerType', '==', 'guardian').get(),
  ]);
  const tokens = new Map<string, string[]>();
  for (const d of devices.docs) {
    const { ownerId, fcmToken } = d.data() as { ownerId: string; fcmToken: string };
    tokens.set(ownerId, [...(tokens.get(ownerId) ?? []), fcmToken]);
  }
  return guardians.docs.flatMap((g) => {
    const d = g.data() as GuardianDoc;
    if (d.revokedAt != null || (d.status !== undefined && d.status !== 'active')) return [];
    const c: GuardianContact = {
      guardianId: g.id,
      notifyChannels: d.notifyChannels ?? ['webpush', 'email'],
      fcmTokens: tokens.get(g.id) ?? [],
    };
    if (d.role === 'primary' || d.role === 'secondary') c.role = d.role;
    if (d.email) c.email = d.email;
    if (d.phoneE164) c.phoneE164 = d.phoneE164;
    return [c];
  });
}

export async function getGuardian(
  db: Firestore,
  familyId: string,
  guardianId: string,
): Promise<GuardianContact | undefined> {
  return (await listGuardians(db, familyId)).find((g) => g.guardianId === guardianId);
}

export async function removeStaleTokens(
  db: Firestore,
  familyId: string,
  tokens: readonly string[],
): Promise<void> {
  if (tokens.length === 0) return;
  const snap = await db
    .collection(`families/${familyId}/devices`)
    .where('fcmToken', 'in', tokens.slice(0, 30))
    .get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

// 同じ出来事からは通知を1件だけ作る：ドキュメント ID が決定論的で、すでに存在すれば false を返す
export async function createNotification(
  db: Firestore,
  familyId: string,
  notificationId: string,
  doc: NotificationDoc,
): Promise<boolean> {
  try {
    await db.doc(notificationPath(familyId, notificationId)).create(doc);
    return true;
  } catch (err) {
    if ((err as { code?: number }).code === 6) return false;
    throw err;
  }
}

export async function recordAttempt(
  db: Firestore,
  familyId: string,
  notificationId: string,
  attempt: Attempt,
): Promise<void> {
  const ref = db.doc(notificationPath(familyId, notificationId));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const status = (snap.data() as NotificationDoc).status;
    const next: Record<string, unknown> = { attempts: FieldValue.arrayUnion(attempt) };
    if (attempt.result === 'sent' && status === 'queued') next['status'] = 'sent';
    tx.update(ref, next);
  });
}

export async function appendCrisisTimeline(
  db: Firestore,
  child: Pick<ChildInfo, 'familyId' | 'childId'>,
  crisisId: string,
  entry: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db
    .doc(crisisPath(child.familyId, child.childId, crisisId))
    .update({ ...extra, timeline: FieldValue.arrayUnion(entry) });
}
