'use client';

import { CalendarConnection } from '@/components/CalendarConnection';
import { ContextEvents } from '@/components/ContextEvents';
import { ChildPicker, useGuardian } from '@/components/GuardianShell';

export default function ContextPage() {
  const { childId, me } = useGuardian();
  return (
    <main className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">
      <ChildPicker />
      {me?.family.consentComplete && (
        <>
          {childId && <ContextEvents key={childId} childId={childId} />}
          <CalendarConnection />
        </>
      )}
    </main>
  );
}
