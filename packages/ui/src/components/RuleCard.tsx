import type { GradeBand } from '@ijime/api-types';
import type { ReactElement } from 'react';

import { Card } from './primitives.js';

export const RULE_CARD_LINES: Record<GradeBand, readonly string[]> = {
  low: [
    'はなした ことは、おうちの ひとには みえないよ。',
    'げんきが ない ひが つづいたら、おうちの ひとに いうか、まず きみに きくね。',
    'おとなの てつだいが いりそうな ときは、きみが「いや」と いっても、なにが あったかは いわずに「きに かけてあげて」とだけ つたえる ことが あるよ。',
    'あぶない ときは、あんぜんな おとなに たすけを もとめよう。おうちが こわい ときは、べつの そうだんさきを あんないするよ。',
    'けしたい ことは、いつでも けせるよ。',
  ],
  high: [
    '話したことは、おうちの人には見えないよ。',
    '元気がない日が続いたら、おうちの人に伝えるかどうか、まず君に聞くね。',
    '大人の手を借りたほうがよさそうな時は、君が「やめて」と言っても、中身は言わずに「気にかけてあげて」とだけ伝えることがあるよ。',
    '命や体が危ない時は、安全な大人に助けを求めよう。おうちの安全が心配な時は、別の相談先を案内するよ。',
    '話したことや、覚えてほしくないことは、いつでも消せるよ。',
  ],
  jhs: [
    '話したことは、おうちの人には見えないよ。',
    '元気がない日が続いたら、おうちの人に伝えるかどうか、まずあなたに聞くね。',
    '大人の手を借りたほうがよさそうな時は、あなたが「やめて」と言っても、中身は言わずに「気にかけてあげて」とだけ伝えることがあるよ。',
    '命や体が危ない時は、安全な大人に助けを求めよう。おうちの安全が心配な時は、別の相談先を案内するよ。',
    '話したことや、覚えてほしくないことは、いつでも消せるよ。',
  ],
};

export const RULE_CARD_TITLE: Record<GradeBand, string> = {
  low: 'ペットとの やくそく',
  high: 'ペットとの約束',
  jhs: 'ペットとの約束',
};

export function RuleCard({
  gradeBand,
  className,
}: {
  gradeBand: GradeBand;
  className?: string;
}): ReactElement {
  return (
    <Card className={className} data-testid="rule-card">
      <h2 className="text-lg font-bold">{RULE_CARD_TITLE[gradeBand]}</h2>
      <ol className="mt-4 space-y-3">
        {RULE_CARD_LINES[gradeBand].map((line, i) => (
          <li key={i} className="flex gap-3 leading-relaxed">
            <span
              aria-hidden="true"
              className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-calm-soft text-sm font-bold text-calm-deep"
            >
              {i + 1}
            </span>
            <span>{line}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
