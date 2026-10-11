import { redirect } from 'next/navigation';

// ペットのお願いは個別ページ /requests/[requestId] だけ。一覧はホームのお願いカードが担う
export default function RequestsIndexPage() {
  redirect('/');
}
