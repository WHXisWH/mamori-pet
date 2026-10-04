import type { GradeBand } from '@ijime/api-types';
import { agent as agentConfig } from '@ijime/config';
import type { OutputFilterRules } from '@ijime/kb-loader';

export type FilterVerdict = { ok: true } | { ok: false; ruleId: string };

export class OutputFilter {
  private readonly compiled: { id: string; re: RegExp }[];

  constructor(rules: OutputFilterRules) {
    this.compiled = rules.rules.flatMap((r) =>
      r.patterns.map((p) => ({ id: r.id, re: new RegExp(p, 'u') })),
    );
  }

  check(sentence: string): FilterVerdict {
    for (const { id, re } of this.compiled) {
      if (re.test(sentence)) return { ok: false, ruleId: id };
    }
    return { ok: true };
  }
}

export function truncateAtSentence(text: string, gradeBand: GradeBand): string {
  const max = agentConfig.replyMaxChars[gradeBand];
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'));
  return cut > 0 ? head.slice(0, cut + 1) : head;
}
