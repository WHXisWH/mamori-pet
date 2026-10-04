'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AssentRes, ChildPreferencesBody } from '@ijime/api-types';

import { AppShell } from '@/components/AppShell';
import { AssentStorybook } from '@/components/AssentStorybook';
import { useChildStore } from '@/lib/store';
import { childRequest } from '@/lib/api';
import { RequestError } from '@/components/RequestError';

export default function WelcomePage() {
  const { assent } = useChildStore();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <AppShell requireLock={false}>
      <AssentStorybook
        busy={busy}
        onAgree={async (sources) => {
          setBusy(true);
          setError(null);
          try {
            await childRequest<AssentRes>('/v1/child/assent', {
              method: 'POST',
              body: JSON.stringify({ documentVersion: 'v0.1', dataSources: sources }),
            });
            const preferences = await childRequest<ChildPreferencesBody>('/v1/child/preferences');
            useChildStore.getState().setGradeBand(preferences.gradeBand);
            useChildStore
              .getState()
              .setReadAloud(preferences.ttsEnabled ?? preferences.gradeBand === 'low');
            assent(sources);
            router.replace('/choose');
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      />
      <div className="mx-auto max-w-md px-4">
        <RequestError error={error} />
      </div>
    </AppShell>
  );
}
