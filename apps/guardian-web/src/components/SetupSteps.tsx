import Link from 'next/link';

export type SetupStep = 'register' | 'pair' | 'assent';

const STEPS: { key: SetupStep; label: string }[] = [
  { key: 'register', label: '子どもを登録' },
  { key: 'pair', label: '端末をつなぐ' },
  { key: 'assent', label: '子どもが説明を確認' },
];

/** はじめての設定の 3 ステップ。current の手前は済み、以降はこれから。 */
export function SetupSteps({ current }: { current: SetupStep }) {
  const index = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="はじめての設定の手順">
      {STEPS.map((step, i) => (
        <li
          key={step.key}
          className={
            i < index ? 'text-emerald-800' : i === index ? 'font-bold text-ink' : 'text-ink/55'
          }
          aria-current={i === index ? 'step' : undefined}
        >
          <span className="mr-1 inline-flex size-5 items-center justify-center rounded-full border border-current text-xs">
            {i < index ? '✓' : i + 1}
          </span>
          {step.label}
        </li>
      ))}
      <li className="text-ink/55">
        <Link href="/guides" className="text-calm underline">
          使い方を見る
        </Link>
      </li>
    </ol>
  );
}
