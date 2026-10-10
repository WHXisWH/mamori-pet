'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import { GuardianHeader, NotificationView } from '@/components/Notifications';

export default function CrisisPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <main className="mx-auto max-w-lg px-4 py-10">
      <GuardianHeader />
      <Link className="mt-5 inline-block text-calm underline" href="/">
        お知らせ一覧へ
      </Link>
      <NotificationView id={id} />
    </main>
  );
}
