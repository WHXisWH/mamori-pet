import { describe, expect, it } from 'vitest';

import { matchEvidence, type Attribution, type EvidenceInput } from './evidence.js';

const report = 'きのう、ぼくがたたかれた。';
const current = (quote: string) => ({ source: 'current' as const, turnIndex: 0, quote });

describe('evidence attribution replay (synthetic, not model accuracy)', () => {
  it.each(['fiction', 'quotation', 'third_party', 'uncertain'] as const)(
    'never promotes %s to a self report despite an exact quote',
    (contextKind) => {
      const evidence = [current(report)];
      expect(
        matchEvidence({ contextKind: 'self_report', evidence }, { current: report }),
      ).toMatchObject({ eligible: true, contextKind: 'self_report', evidenceMatched: true });
      expect(matchEvidence({ contextKind, evidence }, { current: report })).toMatchObject({
        eligible: false,
        contextKind,
        evidenceMatched: true,
      });
    },
  );

  it.each([
    {},
    { contextKind: 'self_report' },
    { contextKind: 'self_report', evidence: [] },
    { contextKind: 'self_report', evidence: [current('')] },
    { contextKind: 'self_report', evidence: [current('モデルが作った文')] },
    { contextKind: 'self_report', evidence: [{ ...current(report), turnIndex: 1 }] },
  ] satisfies Attribution[])('downgrades missing or ungrounded evidence: %j', (output) => {
    expect(matchEvidence(output, { current: report }).eligible).toBe(false);
  });

  it('requires a current anchor, and accepts only child speech from the provided context', () => {
    const output: Attribution = {
      contextKind: 'self_report',
      evidence: [current('ぼくのことだよ'), { source: 'prior', turnIndex: 0, quote: report }],
    };
    const input: EvidenceInput = {
      current: 'ぼくのことだよ',
      prior: [{ role: 'child', text: report }],
    };
    expect(matchEvidence(output, input).eligible).toBe(true);
    expect(matchEvidence({ ...output, evidence: output.evidence!.slice(1) }, input).eligible).toBe(
      false,
    );
    for (const role of ['pet', 'system'] as const) {
      expect(matchEvidence(output, { ...input, prior: [{ role, text: report }] }).eligible).toBe(
        false,
      );
    }
    expect(matchEvidence(output, { current: input.current }).eligible).toBe(false);
  });

  it('rejects missing input and never normalizes a different quote into a match', () => {
    const output: Attribution = { contextKind: 'self_report', evidence: [current(report)] };
    expect(matchEvidence(output).eligible).toBe(false);
    expect(matchEvidence(output, { current: report.replace('ぼく', '私') }).eligible).toBe(false);
    expect(matchEvidence(output, { current: report }).eligible).toBe(true);
  });
});
