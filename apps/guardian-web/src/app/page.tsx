'use client';

import { NotificationList } from '@/components/Notifications';
import { ChildPicker, useGuardian } from '@/components/GuardianShell';
import { InstallHint } from '@/components/PushRegistration';
import { WeeklyReport } from '@/components/WeeklyReport';

export default function HomePage() {
  const { childId, me } = useGuardian();
  return (
    <main className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">
      <ChildPicker />
      {childId && me?.family.consentComplete && <WeeklyReport key={childId} childId={childId} />}
      <NotificationList childId={childId} />
      <InstallHint />
      <section className="mt-8 border-t border-ink/10 py-5">
        <h2 className="font-bold">緊急のときは</h2>
        <p className="mt-2 text-sm">
          命や体に危険があるときは、119 または 110 に電話してください。
        </p>
        <p className="mt-2 text-sm">24時間子供SOSダイヤル：0120-0-78310</p>
      </section>
    </main>
  );
}
