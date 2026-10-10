'use client';

import restCopy from '@/generated/rest_reminders.json';
import { useChildStore } from '@/lib/store';
import { FuriganaText } from './FuriganaText';
import { ReadAloudButton } from './requests/ReadAloudButton';

export function RestReminder({ className = 'flex' }: { className?: string }) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  return (
    <aside
      data-testid="rest-reminder"
      className={`mx-auto w-full max-w-md shrink-0 items-start gap-2 px-4 py-3 text-sm leading-relaxed ${className}`}
    >
      <p className="min-w-0 flex-1 break-words">
        <FuriganaText text={restCopy.replies[gradeBand]} enabled={gradeBand === 'low'} />
      </p>
      <ReadAloudButton text={restCopy.replies[gradeBand]} className="shrink-0" />
    </aside>
  );
}
