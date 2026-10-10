'use client';

import { Button } from '@ijime/ui';
import Link from 'next/link';

import { ChildApiError, errorMessage } from '@/lib/api';

function nextStep(error: unknown): { href: string; label: string } | undefined {
  if (!(error instanceof ChildApiError)) return undefined;
  if (error.code === 'UNAUTHENTICATED')
    return { href: '/pair?reconnect=1', label: 'おとなと つなぎなおす' };
  if (error.code === 'DATA_SOURCE_DISABLED') return { href: '/settings', label: 'せっていを みる' };
  if (error.code === 'MODEL_UNAVAILABLE')
    return { href: '/help', label: 'たすけてくれる ところを みる' };
  if (error.code === 'PERMISSION_DENIED')
    return { href: '/safe', label: 'あんぜんの ページを みる' };
  return undefined;
}

export function RequestError({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  const action = nextStep(error);
  return (
    <div role="alert" data-testid="request-error" className="my-3 space-y-2 text-sm text-ink-soft">
      <p>{errorMessage(error)}</p>
      <div className="flex flex-wrap gap-2">
        {retry && (
          <Button variant="secondary" size="md" onClick={retry}>
            もういちど
          </Button>
        )}
        {action && (
          <Link
            href={action.href}
            className="inline-flex min-h-10 items-center rounded-full border-2 border-calm px-4 py-2 font-bold text-ink"
          >
            {action.label}
          </Link>
        )}
      </div>
    </div>
  );
}
