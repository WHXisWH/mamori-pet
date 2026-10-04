export type ContextKind = 'self_report' | 'fiction' | 'quotation' | 'third_party' | 'uncertain';

export type Evidence = {
  source: 'current' | 'prior';
  turnIndex: number;
  quote: string;
};

// Optional only for legacy outputs: absence never grants explicit status.
export type Attribution = { contextKind?: ContextKind; evidence?: Evidence[] };
export type EvidenceInput = {
  current: string;
  prior?: readonly { role: 'child' | 'pet' | 'system'; text: string }[];
};
export type EvidenceMatch = {
  contextKind: ContextKind;
  evidenceMatched: boolean;
  eligible: boolean;
};

// Exact matching proves source attribution, not the truth or clinical meaning of a statement.
// Quotes stay in memory; callers persist only sourceRef and the non-text match result.
export function matchEvidence(output: Attribution, input?: EvidenceInput): EvidenceMatch {
  const contextKind = output.contextKind ?? 'uncertain';
  const evidence = output.evidence ?? [];
  const evidenceMatched =
    !!input &&
    evidence.length > 0 &&
    evidence.every((e) => {
      if (!e.quote.trim() || !Number.isInteger(e.turnIndex)) return false;
      if (e.source === 'current') return e.turnIndex === 0 && input.current.includes(e.quote);
      if (e.source !== 'prior' || e.turnIndex < 0 || e.turnIndex >= 3) return false;
      const turn = input.prior?.[e.turnIndex];
      return turn?.role === 'child' && turn.text.includes(e.quote);
    });
  return {
    contextKind,
    evidenceMatched,
    eligible:
      contextKind === 'self_report' &&
      evidenceMatched &&
      evidence.some((e) => e.source === 'current'),
  };
}
