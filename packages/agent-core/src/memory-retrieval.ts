export type MemoryCandidate = {
  text: string;
  createdAt?: Date | number;
};

export type RankedMemory = MemoryCandidate & { score: number };

// A small, reviewable Japanese synonym map gives the local fallback some semantic
// recall without pretending to be a hosted embedding model.
const SEMANTIC_GROUPS = [
  ['いじめ', '仲間外れ', '無視', 'からかい'],
  ['学校', '教室', '先生', 'クラス'],
  ['友達', 'ともだち', '同級生', 'なかま'],
  ['気持ち', 'こころ', '感じ', 'つらい'],
  ['家族', 'おうち', 'お母さん', 'お父さん'],
  ['話す', 'はなす', '相談', '聞く', 'きく'],
] as const;

function termsOf(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  const segmenter = new Intl.Segmenter('ja', { granularity: 'word' });
  return [
    ...new Set(
      [...segmenter.segment(normalized)]
        .filter((part) => part.isWordLike && part.segment.trim().length > 1)
        .map((part) => part.segment),
    ),
  ];
}

function expandedTerms(terms: readonly string[]): Set<string> {
  const expanded = new Set(terms);
  for (const group of SEMANTIC_GROUPS) {
    if (group.some((term) => terms.includes(term))) for (const term of group) expanded.add(term);
  }
  return expanded;
}

function createdAtMillis(value: Date | number | undefined): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : 0;
}

/** Rank already-authorized memories. This function never decrypts or persists content. */
export function rankMemories(
  query: string,
  candidates: readonly MemoryCandidate[],
  limit = 5,
): RankedMemory[] {
  const terms = termsOf(query);
  if (terms.length === 0 || limit <= 0) return [];
  const expanded = expandedTerms(terms);
  return candidates
    .map((candidate) => {
      const text = candidate.text.normalize('NFKC').toLowerCase();
      const candidateTerms = termsOf(candidate.text);
      const exact = terms.filter((term) => text.includes(term)).length;
      const related = [...expanded].filter(
        (term) => !terms.includes(term) && text.includes(term),
      ).length;
      const tokenOverlap = candidateTerms.filter((term) => expanded.has(term)).length;
      return { ...candidate, score: exact * 4 + tokenOverlap * 2 + related };
    })
    .filter((candidate) => candidate.score > 0)
    .sort(
      (a, b) => b.score - a.score || createdAtMillis(b.createdAt) - createdAtMillis(a.createdAt),
    )
    .slice(0, limit);
}
