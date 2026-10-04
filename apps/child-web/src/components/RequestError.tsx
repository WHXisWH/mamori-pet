'use client';

import { Button } from '@ijime/ui';
import { errorMessage } from '@/lib/api';

export function RequestError({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" data-testid="request-error" className="my-3 space-y-2 text-sm text-ink-soft">
      <p>{errorMessage(error)}</p>
      {retry && (
        <Button variant="secondary" size="md" onClick={retry}>
          もういちど
        </Button>
      )}
    </div>
  );
}
