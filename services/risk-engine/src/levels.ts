import { RISK_LEVELS, type Domain, type RiskLevel } from '@ijime/api-types';
import type { RiskRules } from '@ijime/kb-loader';

export function rank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

export function isHigher(a: RiskLevel, b: RiskLevel): boolean {
  return rank(a) > rank(b);
}

export type ExplicitSignal = { domain: Domain; signalDefId: string; scoring?: string };

// 明確な発言のルール：kb の levels.l3.or_explicit_in にある領域で explicit シグナルが出たら L3 と判定する。コールドスタートの制限を受けない
export function explicitL3(
  signals: readonly ExplicitSignal[],
  rules: RiskRules,
): { hit: boolean; domains: Domain[] } {
  const allowed = new Set(rules.levels.l3.or_explicit_in ?? []);
  const domains = [...new Set(signals.map((s) => s.domain).filter((d) => allowed.has(d)))].sort();
  return { hit: domains.length > 0, domains };
}

export type Explanation = { domains: Domain[]; days: number; explicit?: boolean; crisis?: boolean };
