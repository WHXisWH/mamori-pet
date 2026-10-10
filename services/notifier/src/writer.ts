import type { BaseLlm } from '@google/adk';
import {
  createExtractorAgent,
  runStructured,
  type JsonSchema,
  type StructuredResult,
  toGenaiSchema,
} from '@ijime/agent-core';
import type { GradeBand } from '@ijime/api-types';
import { agent as agentConfig, models } from '@ijime/config';
import type { Kb } from '@ijime/kb-loader';
import { z } from 'zod';

import type { NotificationPayload } from './store.js';

export const WRITER_PROMPT = 'prompts/notification_writer.md';
export const WRITER_SCHEMA = 'schemas/notification_writer.json';
export const BANNED_FILE = 'templates/notifications/banned.yaml';
export const DOMAINS_FILE = 'templates/notifications/domains.ja.yaml';

// 要約のうちこの文字数以上が連続してモデル出力に現れたら、子どもの言葉を引用したとみなす
const QUOTE_MIN_CHARS = 6;

export type WriterOutput = Pick<
  NotificationPayload,
  'title' | 'changes' | 'meaning' | 'suggestions'
>;
export type Reason = NotificationPayload['reason'];
type WriterFacts = Pick<WriterOutput, 'title' | 'changes' | 'meaning'>;

const bannedSchema = z.object({
  banned: z.array(z.string().min(1)),
  advice_observation_patterns: z.array(z.string().min(1)).default([]),
});
const domainsSchema = z.object({ labels: z.record(z.string(), z.string()) });

export async function loadBanned(kb: Kb): Promise<string[]> {
  return (await kb.yaml(BANNED_FILE, bannedSchema)).banned;
}

export async function loadAdviceObservationPatterns(kb: Kb): Promise<RegExp[]> {
  const rules = await kb.yaml(BANNED_FILE, bannedSchema);
  return rules.advice_observation_patterns.map((pattern) => new RegExp(pattern, 'u'));
}

export async function loadDomainLabels(kb: Kb): Promise<Record<string, string>> {
  return (await kb.yaml(DOMAINS_FILE, domainsSchema)).labels;
}

export function describeReason(reason: Reason, labels: Record<string, string>): string {
  if (reason.domains.length === 0) return '記録上の変化の根拠はありません';
  const names = reason.domains.map((d) => labels[d] ?? d).join('、');
  return reason.days > 0
    ? `${names}（記録上の変化：${reason.days}日ほど）`
    : `${names}（本人の申告に関連する領域です。観察された変化や継続日数ではありません）`;
}

export function buildWriterInstruction(
  template: string,
  vars: {
    nickname: string;
    gradeBand: GradeBand;
    explanation: string;
    childSummary: string | null;
    facts: string;
  },
): string {
  return template.replace(
    /\{(nickname|gradeBand|explanation|childSummary|facts)\}/g,
    (_m, k: keyof typeof vars) => vars[k] ?? 'null',
  );
}

function strings(out: WriterOutput): string[] {
  return [out.title, out.meaning, ...out.changes, ...out.suggestions.try, ...out.suggestions.avoid];
}

function quotes(text: string, summary: string): boolean {
  const s = summary.replace(/\s/g, '');
  const t = text.replace(/\s/g, '');
  if (s.length < QUOTE_MIN_CHARS) return s.length > 1 && t.includes(s);
  for (let i = 0; i + QUOTE_MIN_CHARS <= s.length; i++) {
    if (t.includes(s.slice(i, i + QUOTE_MIN_CHARS))) return true;
  }
  return false;
}

export function violations(
  out: WriterOutput,
  rules: {
    banned: readonly string[];
    childSummary: string | null;
    facts?: WriterFacts;
    adviceObservationPatterns?: readonly RegExp[];
  },
): string[] {
  const all = strings(out);
  const advice = [...out.suggestions.try, ...out.suggestions.avoid];
  const found: string[] = [];
  if (!out.title.trim() || !out.meaning.trim() || all.some((s) => !s.trim())) found.push('empty');
  if (all.some((s) => rules.banned.some((w) => s.includes(w)))) found.push('banned');
  const facts = rules.facts;
  const factsMatch =
    !facts ||
    (out.title === facts.title &&
      out.meaning === facts.meaning &&
      out.changes.length === facts.changes.length &&
      out.changes.every((change, i) => change === facts.changes[i]));
  // Trusted, verbatim template text is not a model quotation of the child's summary.
  const quoteCandidates = rules.facts && factsMatch ? advice : all;
  if (rules.childSummary && quoteCandidates.some((s) => quotes(s, rules.childSummary!)))
    found.push('quote');
  if (!factsMatch) found.push('unsupported_facts');
  if (advice.some((s) => rules.adviceObservationPatterns?.some((pattern) => pattern.test(s))))
    found.push('unsupported_observation');
  return found;
}

export async function writeCareHint(input: {
  kb: Kb;
  model: string | BaseLlm;
  nickname: string;
  gradeBand: GradeBand;
  reason: Reason;
  childSummary: string | null;
  facts: WriterFacts;
}): Promise<StructuredResult<WriterOutput>> {
  const { kb } = input;
  const schema = JSON.parse(await kb.text(WRITER_SCHEMA)) as JsonSchema;
  const banned = await loadBanned(kb);
  const adviceObservationPatterns = await loadAdviceObservationPatterns(kb);
  const instruction = buildWriterInstruction(await kb.text(WRITER_PROMPT), {
    nickname: input.nickname,
    gradeBand: input.gradeBand,
    explanation: describeReason(input.reason, await loadDomainLabels(kb)),
    childSummary: input.childSummary,
    facts: JSON.stringify(input.facts),
  });
  const agent = createExtractorAgent({
    name: 'notification_writer',
    description: '保護者向けのお知らせ文を書く',
    model: input.model,
    instruction: () => instruction,
    outputSchema: toGenaiSchema(schema),
    temperature: models.notificationWriter.temperature ?? 0.3,
  });
  return runStructured<WriterOutput>(agent, 'お知らせ文を JSON で書いてください。', {
    schema,
    timeoutMs: models.notificationWriter.timeoutMs ?? 20000,
    maxAttempts: 1 + agentConfig.notificationWriterMaxRetries,
    accept: (v) =>
      violations(v, {
        banned,
        childSummary: input.childSummary,
        facts: input.facts,
        adviceObservationPatterns,
      }).length === 0,
  });
}
