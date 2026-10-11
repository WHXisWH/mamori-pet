import { redirect } from 'next/navigation';

// 招待リンクは /invite/[id]。ここに直接来たら設定の招待欄へ
export default function InviteIndexPage() {
  redirect('/settings');
}
