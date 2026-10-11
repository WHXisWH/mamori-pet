import Link from 'next/link';

import { CHILD_APP_URL } from '@/lib/api';

export default function GuidesPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 text-sm leading-7">
      <h1 className="text-2xl font-bold">使い方</h1>
      <section className="mt-6">
        <h2 className="text-lg font-bold">はじめての設定（約5分）</h2>
        <ol className="mt-2 list-decimal space-y-2 pl-5">
          <li>
            保護者として登録し、同意の内容を確認します（
            <Link href="/consent" className="text-calm underline">
              同意を確認
            </Link>
            ）。
          </li>
          <li>
            <Link href="/children/new" className="text-calm underline">
              子どもを登録
            </Link>
            します。ニックネームと学年を入れるだけで、本名は要りません。
          </li>
          <li>
            「端末をつなぐ」でペアリング番号を発行し、お子さんの端末で子ども用アプリ（
            <a href={`${CHILD_APP_URL}/pair`} className="font-mono break-all text-calm underline">
              {CHILD_APP_URL}/pair
            </a>
            ）を開いて番号を入力します。番号は10分間・1回だけ使えます。
          </li>
          <li>
            お子さんがアプリの説明（何を覚えるか、いつ大人に知らせるか）を読んで「わかった」と答え、ペットを選ぶと完了です。
          </li>
        </ol>
      </section>
      <section className="mt-8">
        <h2 className="text-lg font-bold">ふだん保護者に届くもの</h2>
        <ul className="mt-2 list-disc space-y-2 pl-5">
          <li>
            <strong>週次レポート</strong>
            ：毎週月曜の朝、その週のようすをことばで短くまとめます。会話の内容や点数は含みません。
          </li>
          <li>
            <strong>お子さんからの相談</strong>
            ：お子さん自身が「代わりに伝えて」を選んだときだけ、本人が確認した要約が届きます。
          </li>
          <li>
            <strong>緊急のお知らせ</strong>
            ：命や体に危険がありそうなとき、すぐに通知します。確認ボタンを押すと、お子さんのアプリにも「大人が見た」と伝わります。
          </li>
          <li>
            <strong>共有された作品</strong>
            ：お子さんが「見せていい」と選んだ絵だけを見られます。
          </li>
        </ul>
      </section>
      <section className="mt-8">
        <h2 className="text-lg font-bold">このアプリが保護者に見せないもの</h2>
        <p className="mt-2">
          会話の原文、リスクの判定、作品の解釈は保護者には表示しません。ペットはお子さんの話し相手であって、見守りカメラではないからです。お子さん自身はいつでも、ペットが覚えたことを見て消せます。
        </p>
      </section>
      <section className="mt-8">
        <h2 className="text-lg font-bold">困ったとき</h2>
        <ul className="mt-2 list-disc space-y-2 pl-5">
          <li>
            番号の期限が切れた：「端末をつなぐ」でもう一度発行してください。前の番号は使えなくなります。
          </li>
          <li>別の端末につなぎ直したい：同じ手順で番号を発行し、新しい端末で入力します。</li>
          <li>
            第二保護者を追加したい：
            <Link href="/settings" className="text-calm underline">
              設定
            </Link>
            の招待から、メールで招待できます。
          </li>
          <li>
            利用をやめたい：
            <Link href="/settings" className="text-calm underline">
              設定
            </Link>
            からお子さんのデータの削除を依頼できます。
          </li>
        </ul>
      </section>
      <p className="mt-8">
        <Link href="/" className="text-calm underline">
          ホームへ
        </Link>
      </p>
    </main>
  );
}
