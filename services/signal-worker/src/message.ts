import type { Domain } from '@ijime/api-types';
import { SkipEvent, type EventPayload } from '@ijime/service-kit';

import type { SignalWorkerDeps } from './deps.js';
import { buildInput, extractorVersion, extractSignals } from './extract.js';
import {
  extractionRuleSignals,
  hourSignals,
  indexDefs,
  modelSignalDefs,
  typingSignals,
  validateModelSignals,
  voiceSignals,
  type SignalDraft,
  type VoiceFeatures,
} from './rules.js';
import { childDocPath, loadSignalDefs, readChild, writeSignals } from './store.js';

const PRIOR_TURNS = 3;

export async function handleMessageCreated(
  deps: SignalWorkerDeps,
  ev: EventPayload<'message.created'>,
): Promise<void> {
  const { db, kb, logger } = deps;
  const child = await readChild(db, ev.familyId, ev.childId);
  if (!child) throw new SkipEvent('child_not_found');
  const ctx = await deps.sessions.readMessageContext(
    ev.childId,
    ev.sessionId,
    ev.messageId,
    PRIOR_TURNS,
  );
  if (!ctx) throw new SkipEvent('source_deleted');
  if (ctx.message.role !== 'child') throw new SkipEvent('not_child_message');

  const sourceRef = `${childDocPath(ev.familyId, ev.childId)}/sessions/${ev.sessionId}/messages/${ev.messageId}`;
  const defs = indexDefs(await loadSignalDefs(kb));
  const sources = child.dataSources ?? {};
  const base = {
    familyId: ev.familyId,
    childId: ev.childId,
    sourceRef,
    occurredAt: ctx.message.createdAt,
    kbVersion: kb.version,
    now: deps.now(),
  };

  // ルールシグナルを先に書き込む：モデルの失敗でリトライしても影響を受けない
  const ruleSignals: SignalDraft[] = [...hourSignals(defs, ctx.message.createdAt)];
  if (ctx.message.inputMode === 'typed' && ctx.message.typing && sources.typing !== false)
    ruleSignals.push(...typingSignals(defs, ctx.message.typing));
  if (ev.channel === 'voice' && sources.voice !== false) {
    const vf = await db
      .collection(`${childDocPath(ev.familyId, ev.childId)}/sessions/${ev.sessionId}/voiceFeatures`)
      .where('messageId', '==', ev.messageId)
      .limit(1)
      .get();
    const f = vf.docs[0]?.data() as VoiceFeatures | undefined;
    if (f) ruleSignals.push(...voiceSignals(defs, f));
  }
  await writeSignals(db, { ...base, extractedBy: 'rule' }, ruleSignals);

  const allowed = modelSignalDefs(defs, 'a', child.gradeBand);
  const result = await extractSignals({
    kb,
    model: deps.model,
    band: child.gradeBand,
    defs: allowed,
    text: buildInput(ctx.message.text, ctx.prior),
  });
  if (!result.ok) {
    logger.warn('signal.extract_failed', {
      messageId: ev.messageId,
      reason: result.reason,
      ...(result.path ? { schemaPath: result.path } : {}),
    });
    throw new Error(`signal extraction failed: ${result.reason}`);
  }
  const modelSignals = validateModelSignals(allowed, result.value.signals, {
    current: ctx.message.text,
    prior: ctx.prior,
  });
  const derived = extractionRuleSignals(defs, result.value);
  await writeSignals(db, { ...base, extractedBy: extractorVersion(kb, deps.model) }, modelSignals);
  await writeSignals(db, { ...base, extractedBy: 'rule' }, derived);

  const all = [...ruleSignals, ...modelSignals, ...derived];
  if (all.length === 0) return;
  const domains = [...new Set(all.map((s) => s.domain))].sort() as Domain[];
  const explicit = all.some((s) => s.explicit);
  await deps.publisher.publish('signal.extracted', { childId: ev.childId, domains, explicit });
  logger.info('signal.extracted', {
    messageId: ev.messageId,
    ruleSignals: ruleSignals.length + derived.length,
    modelSignals: modelSignals.length,
    dropped: result.value.signals.length - modelSignals.length,
    explicit,
  });
}
