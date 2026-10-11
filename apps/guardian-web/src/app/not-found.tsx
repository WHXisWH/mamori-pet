import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 text-sm leading-7">
      <h1 className="text-2xl font-bold">このページは見つかりません</h1>
      <p className="mt-4">アドレスが古いか、まちがっている可能性があります。</p>
      <p className="mt-4 flex flex-wrap gap-4">
        <Link href="/" className="text-calm underline">
          ホームへ
        </Link>
        <Link href="/children" className="text-calm underline">
          お子さん
        </Link>
        <Link href="/guides" className="text-calm underline">
          使い方
        </Link>
      </p>
    </main>
  );
}
