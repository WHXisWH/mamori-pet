'use client';

import { NotificationList } from '@/components/Notifications';
import { ChildPicker, useGuardian } from '@/components/GuardianShell';

export default function NotificationsPage() {
  const { childId } = useGuardian();
  return (
    <main className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">
      <h1 className="mt-6 text-2xl font-bold">お知らせ</h1>
      <ChildPicker />
      <NotificationList childId={childId} />
    </main>
  );
}
