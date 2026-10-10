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

export function splitCompleteSentences(
  text: string,
  final: boolean,
): {
  complete: string[];
  pending: string;
} {
  const complete: string[] = [];
  const quotes: string[] = [];
  const closers: Record<string, string> = { '「': '」', '『': '』', '“': '”' };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (closers[char]) quotes.push(closers[char]!);
    else if (char === quotes.at(-1)) quotes.pop();
    // Newlines and punctuation inside practice quotes cannot be sent on their own.
    if (quotes.length === 0 && /[。！？!?]/u.test(char)) {
      complete.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (final && quotes.length === 0 && text.slice(start).trim()) {
    complete.push(text.slice(start));
    start = text.length;
  }
  return { complete, pending: text.slice(start) };
}
