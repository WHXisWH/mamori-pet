import type { Lexicon } from '@ijime/kb-loader';

import {
  CrisisDetector,
  type CrisisDetectorOptions,
  type CrisisInput,
  type CrisisReviewer,
  type ReviewResult,
  type SemanticScreener,
} from './detector.js';
import { KeywordMatcher } from './keyword.js';

// モデルを接続していないときの2層実装。意味スクリーニングは常に「疑いなし」を返し、再判定は「キーワードに一致したら確定」とする
export class NoModelScreener implements SemanticScreener {
  async screen(): Promise<{ suspect: boolean }> {
    return { suspect: false };
  }
}

export class KeywordConfirmReviewer implements CrisisReviewer {
  constructor(private readonly matcher: KeywordMatcher) {}

  async review(input: CrisisInput): Promise<ReviewResult> {
    const m = this.matcher.match(input.text);
    if (!m.hit) return { hit: false, category: 'none', confidence: 0 };
    return { hit: true, category: 'other', confidence: 0.5 };
  }
}

export function createNoModelDetector(
  lexicon: Lexicon,
  opts: CrisisDetectorOptions = {},
): CrisisDetector {
  const matcher = KeywordMatcher.fromLexicon(lexicon);
  return new CrisisDetector(
    matcher,
    new NoModelScreener(),
    new KeywordConfirmReviewer(matcher),
    opts,
  );
}
