import type { Firestore } from '@google-cloud/firestore';
import type { BaseLlm } from '@google/adk';
import {
  childPath,
  createExtractorAgent,
  runStructured,
  toGenaiSchema,
  type ChildRecord,
  type FirestoreSessionService,
  type JsonSchema,
  type OutputFilter,
} from '@ijime/agent-core';
import { agent } from '@ijime/config';
import type { Kb } from '@ijime/kb-loader';

import { asDate } from './context.js';

export const AGENT_SUMMARY_INTERVAL_TURNS = agent.summaryIntervalTurns;

type SummaryMessage = { role: 'child' | 'pet'; text: string };
export type SummaryGenerator = (messages: readonly SummaryMessage[]) => Promise<string>;

export function createModelSummaryGenerator(
  kb: Kb,
  model: BaseLlm,
  filter: OutputFilter,
): SummaryGenerator {
  return async (messages) => {
    const schema = JSON.parse(await kb.text('schemas/agent_summary.json')) as JsonSchema;
    const summarizer = createExtractorAgent({
      name: 'agent_summary',
      description: 'Private coarse conversation summary; no tools or advice',
      model,
      instruction: await kb.text('prompts/agent_summary.md'),
      outputSchema: toGenaiSchema(schema),
      temperature: 0,
    });
    const result = await runStructured<{ summary: string }>(
      summarizer,
      JSON.stringify({ messages }),
      {
        schema,
        timeoutMs: agent.summaryTimeoutMs,
        maxAttempts: 1,
        accept: ({ summary }) => summary.trim().length > 0 && filter.check(summary).ok,
      },
    );
    if (!result.ok) throw new Error('summary_generation_failed');
    return result.value.summary.trim();
  };
}

const TOPICS: ReadonlyArray<readonly [string, string]> = [
  ['学校', '学校のこと'],
  ['教室', '教室のこと'],
  ['先生', '先生のこと'],
  ['友達', '友達のこと'],
  ['ともだち', '友達のこと'],
  ['家族', '家族のこと'],
  ['おうち', '家族のこと'],
  ['ゲーム', '遊びのこと'],
  ['絵', '絵のこと'],
];

export function buildSafeAgentSummary(messages: readonly SummaryMessage[]): string {
  const childText = messages
    .filter((message) => message.role === 'child')
    .map((message) => message.text.normalize('NFKC'))
    .join(' ');
  if (!childText.trim()) return '';
  const topics = [
    ...new Set(TOPICS.filter(([term]) => childText.includes(term)).map(([, label]) => label)),
  ];
  if (topics.length === 0) return '最近は ペットと おはなしを している。';
  return `最近は ${topics.slice(0, 2).join('、')} の 話を している。`;
}

/** Store only a coarse, unapproved summary. It is not put back into model context until reviewed. */
export async function maybeWriteAgentSummary(
  db: Firestore,
  sessions: FirestoreSessionService,
  child: ChildRecord,
  sessionId: string,
  now = new Date(),
  generate?: SummaryGenerator,
): Promise<boolean> {
  const base = childPath(child.familyId, child.childId);
  const childRef = db.doc(base);
  const sessionRef = db.doc(`${base}/sessions/${sessionId}`);
  const owner = await childRef.get();
  const session = await sessionRef.get();
  if (
    !owner.exists ||
    owner.get('status') !== 'active' ||
    session.get('safeMode') ||
    session.get('endedAt')
  )
    return false;
  const turnCount = Number(session.get('turnCount') ?? 0);
  if (turnCount === 0 || turnCount % AGENT_SUMMARY_INTERVAL_TURNS !== 0) return false;
  if (
    owner.get('agentSummary.sessionId') === sessionId &&
    Number(owner.get('agentSummary.throughTurn') ?? 0) >= turnCount
  )
    return false;
  const resetAt = asDate(owner.get('modelHistoryResetAt'))?.getTime() ?? 0;
  const path = `${base}/sessions/${sessionId}/messages`;
  const recent = await db
    .collection(path)
    .orderBy('createdAt', 'desc')
    .limit(agent.summaryMaxMessages)
    .get();
  const messages: SummaryMessage[] = recent.docs
    .flatMap((doc) => {
      const data = doc.data();
      const createdAt = asDate(data['createdAt']);
      const expiresAt = asDate(data['expireAt']);
      if (
        !['child', 'pet'].includes(data['role']) ||
        data['crisisCheck']?.pendingReview ||
        data['crisisCheck']?.hit ||
        !createdAt ||
        createdAt.getTime() <= resetAt ||
        createdAt > now ||
        !expiresAt ||
        expiresAt <= now
      )
        return [];
      return [
        {
          role: data['role'] as 'child' | 'pet',
          text: sessions.decryptForChild(
            child,
            Buffer.from(data['contentEnc']),
            `${path}#contentEnc`,
          ),
        },
      ];
    })
    .reverse();
  if (!messages.some((message) => message.role === 'child')) return false;
  const summary = generate ? await generate(messages) : buildSafeAgentSummary(messages);
  if (!summary) return false;
  return db.runTransaction(async (tx) => {
    const currentOwner = await tx.get(childRef);
    const currentSession = await tx.get(sessionRef);
    if (
      !currentOwner.exists ||
      currentOwner.get('status') !== 'active' ||
      !currentSession.exists ||
      currentSession.get('safeMode') ||
      currentSession.get('endedAt') ||
      currentSession.get('petId') !== child.petId ||
      Number(currentSession.get('turnCount')) !== turnCount ||
      (asDate(currentOwner.get('modelHistoryResetAt'))?.getTime() ?? 0) !== resetAt ||
      (currentOwner.get('activePetId') && currentOwner.get('activePetId') !== child.petId)
    )
      return false;
    if (
      currentOwner.get('agentSummary.sessionId') === sessionId &&
      Number(currentOwner.get('agentSummary.throughTurn') ?? 0) >= turnCount
    )
      return false;
    tx.update(childRef, {
      agentSummary: {
        textEnc: sessions.encryptForChild(child, summary, `${base}#agentSummary.textEnc`),
        approved: false,
        petId: child.petId,
        source: generate ? 'model' : 'local_safe_template',
        sessionId,
        throughTurn: turnCount,
        generatedAt: now,
        expiresAt: new Date(now.getTime() + agent.summaryRetentionDays * 86_400_000),
      },
    });
    return true;
  });
}
