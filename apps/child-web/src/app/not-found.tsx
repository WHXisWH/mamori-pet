import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-calm-soft px-6 text-center">
      <p className="text-lg font-bold">この ページは ないみたい。</p>
      <div className="flex flex-wrap justify-center gap-3">
        <Link
          href="/"
          className="min-h-12 rounded-card bg-leaf px-6 py-3 font-bold text-white shadow-soft"
        >
          ホームへ もどる
        </Link>
        <Link
          href="/help"
          className="min-h-12 rounded-card bg-white px-6 py-3 font-bold text-ink shadow-soft"
        >
          こまったとき
        </Link>
      </div>
    </main>
  );
}
