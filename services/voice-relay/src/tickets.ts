import type { Firestore, Timestamp } from '@google-cloud/firestore';
import { VOICE_TICKETS, tokenDigest } from '@ijime/service-kit';

export type TicketOwner = { childId: string; familyId: string };

type TicketDoc = {
  childId: string;
  familyId: string;
  expiresAt: Timestamp | Date;
  usedAt?: Timestamp | Date;
};

const toDate = (v: Timestamp | Date): Date => (v instanceof Date ? v : v.toDate());

// トランザクションで消費する：成功するのは期限内の最初の1回だけ。子どもの識別はチケットからのみ得られ、接続する側は指定できない
export async function redeemTicket(
  db: Firestore,
  ticket: string,
  now: Date,
): Promise<TicketOwner | null> {
  if (!ticket || ticket.length > 128) return null;
  const ref = db.collection(VOICE_TICKETS).doc(tokenDigest(ticket));
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data() as TicketDoc | undefined;
    if (!d || d.usedAt || toDate(d.expiresAt) <= now) return null;
    tx.update(ref, { usedAt: now });
    return { childId: d.childId, familyId: d.familyId };
  });
}
