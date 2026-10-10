import { randomUUID } from 'node:crypto';

import {
  BaseSessionService,
  createEvent,
  createSession,
  type AppendEventRequest,
  type CreateSessionRequest,
  type DeleteSessionRequest,
  type Event,
  type GetSessionRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type Session,
} from '@google/adk';
import type { Content } from '@google/genai';
import { Timestamp, type Firestore, type Transaction } from '@google-cloud/firestore';
import type { Channel, TypingMetrics } from '@ijime/api-types';
import { agent as agentConfig, retention } from '@ijime/config';
import { EnvelopeCipher, fieldAad, LocalKeyWrapper } from '@ijime/crypto';

import { childPath, type ChildDirectory } from './child-directory.js';
import { buildHistoryExcerpt, type HistoricalUtterance } from './history-context.js';

export const PET_APP_NAME = 'pet';

export type MessageRole = 'child' | 'pet' | 'system';

export type MessageDoc = {
  role: MessageRole;
  contentEnc: Buffer;
  partsEnc?: Buffer;
  inputMode: 'typed' | 'voice_transcript' | 'quick_reply' | 'model' | 'tool';
  typing?: TypingMetrics;
  // pendingReview：モデルが利用できないときに保留して再審査を待っているメッセージ。ペットのコンテキストには入れない
  crisisCheck?: {
    hit: boolean;
    method: string;
    score: number;
    checkedAt: Date;
    pendingReview?: boolean;
    recheckedAt?: Date;
  };
  modelInfo?: { model: string; latencyMs: number; promptVersion: string };
  invocationId?: string;
  createdAt: Date | Timestamp;
  expireAt: Date;
};

export type SessionDoc = {
  petId: string;
  channel: Channel;
  startedAt: Date | Timestamp;
  endedAt?: Date | Timestamp;
  localHour: number;
  turnCount: number;
  safeMode: boolean;
  expireAt: Date;
  adkState?: Record<string, unknown>;
};

function toDate(v: Date | Timestamp): Date {
  return v instanceof Date ? v : v.toDate();
}

function historyTimestamp(value: unknown): number | undefined {
  const ms =
    value instanceof Date ? value.getTime() : value instanceof Timestamp ? value.toMillis() : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

function jstHour(d: Date): number {
  return (
    Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Tokyo' })
        .format(d)
        .replace(/\D/g, ''),
    ) % 24
  );
}

function expireFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

function withoutThoughtText(content: Content): Content {
  if (!content.parts) return content;
  return {
    ...content,
    parts: content.parts.flatMap((part) => {
      if (part.thought !== true) return [part];
      // Remove thought text without altering opaque signatures or function payloads.
      const sanitized = { ...part };
      delete sanitized.text;
      return Object.keys(sanitized).some((key) => key !== 'thought') ? [sanitized] : [];
    }),
  };
}

export type FirestoreSessionServiceOptions = {
  writeUserEvents?: boolean;
};

export class FirestoreSessionService extends BaseSessionService {
  private readonly cipher = new EnvelopeCipher(new LocalKeyWrapper());

  constructor(
    private readonly db: Firestore,
    private readonly directory: ChildDirectory,
    private readonly opts: FirestoreSessionServiceOptions = {},
  ) {
    super();
  }

  private async paths(childId: string) {
    const child = await this.directory.lookup(childId);
    if (!child) throw new Error(`unknown child ${childId}`);
    const base = childPath(child.familyId, childId);
    return { child, sessions: `${base}/sessions` };
  }

  private async mutateSession(
    child: { childId: string; familyId: string },
    sessionId: string,
    write: (tx: Transaction, current: SessionDoc) => void,
  ): Promise<void> {
    const base = childPath(child.familyId, child.childId);
    await this.db.runTransaction(async (tx) => {
      const owner = await tx.get(this.db.doc(base));
      const session = await tx.get(this.db.doc(`${base}/sessions/${sessionId}`));
      if (!owner.exists || owner.get('status') !== 'active') throw new Error('child_not_active');
      if (!session.exists) throw new Error('session_not_found');
      write(tx, session.data() as SessionDoc);
    });
  }

  async createSession({ userId, state, sessionId }: CreateSessionRequest): Promise<Session> {
    const { child, sessions } = await this.paths(userId);
    const id = sessionId ?? randomUUID();
    const now = new Date();
    const doc: SessionDoc = {
      petId: child.petId,
      channel: (state?.['channel'] as Channel | undefined) ?? 'text',
      startedAt: now,
      localHour: jstHour(now),
      turnCount: 0,
      safeMode: false,
      expireAt: expireFromNow(retention.sessionsDays),
      adkState: state ?? {},
    };
    await this.db.runTransaction(async (tx) => {
      const owner = await tx.get(this.db.doc(childPath(child.familyId, userId)));
      if (!owner.exists || owner.get('status') !== 'active') throw new Error('child_not_active');
      tx.create(this.db.doc(`${sessions}/${id}`), doc);
    });
    return createSession({
      id,
      appName: PET_APP_NAME,
      userId,
      state: state ?? {},
      events: [],
      lastUpdateTime: now.getTime(),
    });
  }

  /**
   * Model-only context: at most H recent stored events plus one ephemeral excerpt event,
   * where H = 2 * contextHistoryTurns (40 today); caller numRecentEvents can reduce H.
   * A single snapshot reads at most H + 2 * contextHistoryTurns messages (80 today).
   * Expired/corrupt/tool-only older rows leave holes; there is no unbounded backfill.
   * Both windows are strictly after max(afterTimestamp, modelHistoryResetAt).
   * Deleting a memory already advances that reset, so no old quote/recall is revived.
   * No summary is cached, persisted in adkState, logged, or returned by UI history APIs.
   * See history-context.ts for the lossy raw-excerpt format and serialization limits.
   */
  async getSession({ userId, sessionId, config }: GetSessionRequest): Promise<Session | undefined> {
    const { child, sessions } = await this.paths(userId);
    const ref = this.db.doc(`${sessions}/${sessionId}`);
    const historyLimit = agentConfig.contextHistoryTurns * 2;
    const requested = config?.numRecentEvents ?? historyLimit;
    const limit = Number.isFinite(requested)
      ? Math.max(1, Math.min(Math.floor(requested), historyLimit))
      : historyLimit;
    const loaded = await this.db.runTransaction(
      async (tx) => {
        const base = childPath(child.familyId, userId);
        const owner = await tx.get(this.db.doc(base));
        if (!owner.exists || owner.get('status') !== 'active') return undefined;
        const snap = await tx.get(ref);
        if (!snap.exists) return undefined;
        const doc = snap.data() as SessionDoc;
        const now = Date.now();
        const expires = historyTimestamp(doc.expireAt);
        if (expires === undefined || expires <= now || doc.petId !== child.petId) return undefined;
        const activePetId = owner.get('activePetId') as unknown;
        if (activePetId !== undefined && activePetId !== doc.petId) return undefined;
        const pet = await tx.get(this.db.doc(`${base}/pets/${doc.petId}`));
        if (!pet.exists || pet.get('active') !== true) return undefined;
        if (historyTimestamp(doc.endedAt ?? doc.startedAt) === undefined) return undefined;
        const resetValue: unknown = owner.get('modelHistoryResetAt');
        const resetAt = resetValue === undefined ? 0 : historyTimestamp(resetValue);
        const callerAfter = config?.afterTimestamp ?? 0;
        if (resetAt === undefined || !Number.isFinite(callerAfter)) return undefined;
        const after = Math.max(callerAfter, resetAt);
        let query = ref.collection('messages').orderBy('createdAt', 'desc');
        if (after > 0) query = query.where('createdAt', '>', new Date(after));
        // One query, no backfill/scan: recent window + one equally bounded older window.
        const msgs = await tx.get(query.limit(limit + historyLimit));
        return { doc, msgs, after, now };
      },
      { readOnly: true },
    );
    if (!loaded) return undefined;
    const { doc, msgs, after, now } = loaded;
    const events: Event[] = [];
    const older: HistoricalUtterance[] = [];
    for (let i = 0; i < msgs.docs.length; i++) {
      const stored = msgs.docs[i]!;
      const message = stored.data() as MessageDoc;
      const timestamp = historyTimestamp(message.createdAt);
      const expires = historyTimestamp(message.expireAt);
      if (
        timestamp === undefined ||
        timestamp <= after ||
        timestamp > now ||
        expires === undefined ||
        expires <= now
      )
        continue;
      if (!['child', 'pet', 'system'].includes(message.role)) continue;
      if (message.crisisCheck?.pendingReview === true) continue;
      // Tools can contain recalled memories. They must never enter the extractive summary.
      if (
        i >= limit &&
        (message.role === 'system' || message.inputMode === 'tool' || message.partsEnc)
      )
        continue;
      try {
        const event = this.toEvent(
          stored.id,
          message,
          child.dek,
          `${sessions}/${sessionId}/messages`,
        );
        if (i < limit) events.unshift(event);
        else if (message.role === 'child' || message.role === 'pet') {
          older.push({
            role: message.role,
            text: event.content?.parts?.[0]?.text ?? '',
            timestamp,
          });
        }
      } catch {
        // Corrupt ciphertext or malformed storage is omitted, never echoed into logs/context.
      }
    }
    const summary = buildHistoryExcerpt(older);
    if (summary)
      events.unshift(
        createEvent({
          id: `history_excerpt_${sessionId}`,
          author: 'user',
          invocationId: '',
          timestamp: summary.timestamp,
          content: { role: 'user', parts: [{ text: summary.text }] },
        }),
      );
    const updated = doc.endedAt ?? doc.startedAt;
    return createSession({
      id: sessionId,
      appName: PET_APP_NAME,
      userId,
      state: doc.adkState ?? {},
      events,
      lastUpdateTime: toDate(updated).getTime(),
    });
  }

  async listSessions({ userId, limit = 20 }: ListSessionsRequest): Promise<ListSessionsResponse> {
    if (!userId) return { sessions: [], page: 1, limit, totalItems: 0, totalPages: 0 };
    const { sessions } = await this.paths(userId);
    const snap = await this.db.collection(sessions).orderBy('startedAt', 'desc').limit(limit).get();
    const list = snap.docs.map((d) => {
      const doc = d.data() as SessionDoc;
      return createSession({
        id: d.id,
        appName: PET_APP_NAME,
        userId,
        state: doc.adkState ?? {},
        events: [],
        lastUpdateTime: toDate(doc.startedAt).getTime(),
      });
    });
    return { sessions: list, page: 1, limit, totalItems: list.length, totalPages: 1 };
  }

  async deleteSession({ userId, sessionId }: DeleteSessionRequest): Promise<void> {
    const { sessions } = await this.paths(userId);
    await this.db.recursiveDelete(this.db.doc(`${sessions}/${sessionId}`));
  }

  override async appendEvent({ session, event }: AppendEventRequest): Promise<Event> {
    if (event.content) event = { ...event, content: withoutThoughtText(event.content) };
    if (event.partial) return super.appendEvent({ session, event });
    const { child, sessions } = await this.paths(session.userId);
    const base = `${sessions}/${session.id}`;
    const role = this.roleOf(event);
    if (role === 'child' && this.opts.writeUserEvents === false)
      return super.appendEvent({ session, event });
    const msg = this.toMessageDoc(event, role, child.dek, `${base}/messages`);
    const stateDelta = event.actions?.stateDelta ?? {};
    const update: Record<string, unknown> = {};
    if (Object.keys(stateDelta).length > 0) {
      for (const [k, v] of Object.entries(stateDelta)) update[`adkState.${k}`] = v;
    }
    await this.mutateSession(child, session.id, (tx, current) => {
      if (msg) tx.set(this.db.doc(`${base}/messages/${event.id}`), msg);
      if (role === 'pet' && msg?.inputMode === 'model')
        update['turnCount'] = (current.turnCount ?? 0) + 1;
      if (Object.keys(update).length > 0) tx.update(this.db.doc(base), update);
    });
    return super.appendEvent({ session, event });
  }

  encryptForChild(child: { dek: Buffer }, text: string, aad: string): Buffer {
    return this.cipher.encrypt(child.dek, text, aad);
  }

  decryptForChild(child: { dek: Buffer }, ciphertext: Buffer, aad: string): string {
    return this.cipher.decryptText(child.dek, ciphertext, aad);
  }

  async markSafeMode(childId: string, sessionId: string): Promise<void> {
    const { child, sessions } = await this.paths(childId);
    await this.mutateSession(child, sessionId, (tx) => {
      tx.update(this.db.doc(`${sessions}/${sessionId}`), { safeMode: true });
    });
  }

  async endSession(childId: string, sessionId: string): Promise<void> {
    const { child, sessions } = await this.paths(childId);
    await this.mutateSession(child, sessionId, (tx) => {
      tx.update(this.db.doc(`${sessions}/${sessionId}`), { endedAt: new Date() });
    });
  }

  async setGameSuggestionsDeclined(
    childId: string,
    sessionId: string,
    declined: boolean,
  ): Promise<void> {
    const { child, sessions } = await this.paths(childId);
    await this.mutateSession(child, sessionId, (tx, current) => {
      if (current.endedAt || current.safeMode) throw new Error('session_not_available');
      tx.update(this.db.doc(`${sessions}/${sessionId}`), {
        'adkState.gameSuggestionsDeclined': declined,
      });
    });
  }

  async writeChildMessage(
    childId: string,
    sessionId: string,
    input: {
      text: string;
      inputMode: 'typed' | 'voice_transcript' | 'quick_reply';
      typing?: TypingMetrics;
      crisisCheck: MessageDoc['crisisCheck'];
    },
  ): Promise<{ messageId: string }> {
    const { child, sessions } = await this.paths(childId);
    const messageId = randomUUID();
    const path = `${sessions}/${sessionId}/messages`;
    const doc: MessageDoc = {
      role: 'child',
      contentEnc: this.cipher.encrypt(child.dek, input.text, fieldAad(path, 'contentEnc')),
      inputMode: input.inputMode,
      createdAt: new Date(),
      expireAt: expireFromNow(retention.messagesDays),
    };
    if (input.typing) doc.typing = input.typing;
    if (input.crisisCheck) doc.crisisCheck = input.crisisCheck;
    await this.mutateSession(child, sessionId, (tx) => {
      tx.create(this.db.doc(`${path}/${messageId}`), doc);
    });
    return { messageId };
  }

  // 音声モードでのペットの1発話の最終文字起こし（テキストモードでは appendEvent が書き込む）
  async writePetTranscript(
    childId: string,
    sessionId: string,
    text: string,
  ): Promise<{ messageId: string }> {
    const { child, sessions } = await this.paths(childId);
    const messageId = randomUUID();
    const base = `${sessions}/${sessionId}`;
    const path = `${base}/messages`;
    const doc: MessageDoc = {
      role: 'pet',
      contentEnc: this.cipher.encrypt(child.dek, text, fieldAad(path, 'contentEnc')),
      inputMode: 'voice_transcript',
      createdAt: new Date(),
      expireAt: expireFromNow(retention.messagesDays),
    };
    await this.mutateSession(child, sessionId, (tx, current) => {
      tx.create(this.db.doc(`${path}/${messageId}`), doc);
      tx.update(this.db.doc(base), { turnCount: (current.turnCount ?? 0) + 1 });
    });
    return { messageId };
  }

  async readMessages(
    childId: string,
    sessionId: string,
    pageSize = 50,
  ): Promise<{ messageId: string; role: MessageRole; text: string; createdAt: Date }[]> {
    const { child, sessions } = await this.paths(childId);
    const path = `${sessions}/${sessionId}/messages`;
    const snap = await this.db.collection(path).orderBy('createdAt', 'asc').limit(pageSize).get();
    return snap.docs
      .map((d) => {
        const m = d.data() as MessageDoc;
        return {
          messageId: d.id,
          role: m.role,
          text:
            m.role === 'system'
              ? ''
              : this.cipher.decryptText(
                  child.dek,
                  Buffer.from(m.contentEnc),
                  fieldAad(path, 'contentEnc'),
                ),
          createdAt: toDate(m.createdAt),
        };
      })
      .filter((m) => m.role !== 'system');
  }

  // 指定したメッセージとその前の数件（system を除く）。復号はメモリ上だけで行う
  async readMessageContext(
    childId: string,
    sessionId: string,
    messageId: string,
    priorCount: number,
  ): Promise<
    | {
        message: {
          role: MessageRole;
          text: string;
          inputMode: MessageDoc['inputMode'];
          typing?: TypingMetrics;
          crisisCheck?: MessageDoc['crisisCheck'];
          createdAt: Date;
        };
        prior: { role: MessageRole; text: string }[];
      }
    | undefined
  > {
    const { child, sessions } = await this.paths(childId);
    const path = `${sessions}/${sessionId}/messages`;
    const snap = await this.db.doc(`${path}/${messageId}`).get();
    if (!snap.exists) return undefined;
    const m = snap.data() as MessageDoc;
    const decrypt = (d: MessageDoc) =>
      this.cipher.decryptText(child.dek, Buffer.from(d.contentEnc), fieldAad(path, 'contentEnc'));
    const createdAt = toDate(m.createdAt);
    const before =
      priorCount > 0
        ? await this.db
            .collection(path)
            .where('createdAt', '<', createdAt)
            .orderBy('createdAt', 'desc')
            .limit(priorCount * 3)
            .get()
        : { docs: [] };
    const prior = before.docs
      .map((d) => d.data() as MessageDoc)
      .filter((d) => d.role !== 'system')
      .slice(0, priorCount)
      .reverse()
      .map((d) => ({ role: d.role, text: decrypt(d) }));
    const message: {
      role: MessageRole;
      text: string;
      inputMode: MessageDoc['inputMode'];
      typing?: TypingMetrics;
      crisisCheck?: MessageDoc['crisisCheck'];
      createdAt: Date;
    } = {
      role: m.role,
      text: m.role === 'system' ? '' : decrypt(m),
      inputMode: m.inputMode,
      createdAt,
    };
    if (m.typing) message.typing = m.typing;
    if (m.crisisCheck) message.crisisCheck = m.crisisCheck;
    return { message, prior };
  }

  private roleOf(event: Event): MessageRole {
    const parts = event.content?.parts ?? [];
    if (parts.some((p) => p.functionCall || p.functionResponse)) return 'system';
    if (event.content?.role === 'user') return 'child';
    return 'pet';
  }

  private toMessageDoc(
    event: Event,
    role: MessageRole,
    dek: Buffer,
    path: string,
  ): MessageDoc | null {
    const parts = event.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? '').join('');
    if (role !== 'system' && text.trim().length === 0) return null;
    const doc: MessageDoc = {
      role,
      contentEnc: this.cipher.encrypt(dek, text, fieldAad(path, 'contentEnc')),
      inputMode: role === 'system' ? 'tool' : role === 'pet' ? 'model' : 'typed',
      createdAt: new Date(event.timestamp),
      expireAt: expireFromNow(retention.messagesDays),
    };
    if (role === 'system') {
      doc.partsEnc = this.cipher.encrypt(
        dek,
        JSON.stringify({ role: event.content?.role, parts }),
        fieldAad(path, 'partsEnc'),
      );
    }
    if (event.invocationId) doc.invocationId = event.invocationId;
    return doc;
  }

  private toEvent(id: string, m: MessageDoc, dek: Buffer, path: string): Event {
    let content: Content;
    if (m.role === 'system' && m.partsEnc) {
      content = withoutThoughtText(
        JSON.parse(
          this.cipher.decryptText(dek, Buffer.from(m.partsEnc), fieldAad(path, 'partsEnc')),
        ) as Content,
      );
    } else {
      const text = this.cipher.decryptText(
        dek,
        Buffer.from(m.contentEnc),
        fieldAad(path, 'contentEnc'),
      );
      content = { role: m.role === 'child' ? 'user' : 'model', parts: [{ text }] };
    }
    const author = content.role === 'user' ? 'user' : 'pet_agent';
    return createEvent({
      id,
      invocationId: m.invocationId ?? '',
      author,
      content,
      timestamp: toDate(m.createdAt).getTime(),
    });
  }
}
