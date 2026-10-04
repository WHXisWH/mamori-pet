import Link from 'next/link';

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 px-4 text-center">
      <p className="text-xl font-bold">いまは ネットに つながっていません</p>
      <Link
        href="/help"
        className="flex min-h-14 items-center justify-center rounded-full bg-calm px-6 font-bold text-white"
      >
        相談窓口をみる
      </Link>
    </main>
  );
}
