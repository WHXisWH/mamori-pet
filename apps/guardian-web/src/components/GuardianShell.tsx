'use client';

import type { MeRes, NotificationsRes } from '@ijime/api-types';
import {
  AlertTriangle,
  CalendarDays,
  Home,
  RefreshCw,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { GuardianApiError, guardianRequest, LOCAL_TEST } from '@/lib/api';

export const control =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-ink/20 bg-white px-3 py-2 text-sm font-medium hover:bg-ink/5 disabled:cursor-not-allowed disabled:opacity-50';
export const field =
  'min-h-11 w-full min-w-0 rounded-md border border-ink/25 bg-white px-3 py-2 text-sm';

type GuardianState = {
  me: MeRes | null;
  familyLoading: boolean;
  familyError: Error | null;
  childId: string;
  selectChild: (id: string) => void;
  reloadFamily: () => Promise<void>;
  notifications: NotificationsRes['items'];
  noticesLoading: boolean;
  noticesError: Error | null;
  reloadNotices: () => Promise<void>;
  acknowledgeNotice: (id: string, acknowledgedAt: string) => void;
};
const GuardianContext = createContext<GuardianState | null>(null);

export function useGuardian() {
  const state = useContext(GuardianContext);
  if (!state) throw new Error('GuardianShell is required');
  return state;
}

export function ApiFailure({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div
      role="alert"
      className="my-4 flex flex-wrap items-center gap-3 border-l-4 border-alert bg-red-50 px-4 py-3"
      data-testid="guardian-error"
    >
      <p className="min-w-0 flex-1 text-sm break-words">
        {error instanceof GuardianApiError
          ? error.message
          : '接続できませんでした。操作は完了していません。'}
      </p>
      <button className={control} onClick={retry}>
        <RefreshCw size={16} aria-hidden />
        再試行
      </button>
    </div>
  );
}

function Header() {
  const path = usePathname();
  return (
    <header className="border-b border-ink/15 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <Link href="/" className="flex min-w-0 items-center gap-2">
          <ShieldCheck size={26} className="shrink-0 text-emerald-700" aria-hidden />
          <h1 className="text-lg font-bold sm:text-xl">まもりペット 保護者用</h1>
        </Link>
        <nav aria-label="メインメニュー" className="flex flex-wrap gap-1">
          {(
            [
              { href: '/', label: 'ホーム', Icon: Home },
              { href: '/context', label: '予定・できごと', Icon: CalendarDays },
              { href: '/children', label: 'お子さん', Icon: Users },
              { href: '/settings', label: '設定', Icon: Settings },
            ] as const
          ).map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={path === href ? 'page' : undefined}
              className={`inline-flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm ${path === href ? 'bg-emerald-50 font-bold text-emerald-800' : 'hover:bg-ink/5'}`}
            >
              <Icon size={18} aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
      </div>
      {LOCAL_TEST && (
        <p
          className="mx-auto max-w-5xl px-4 pb-3 text-xs text-ink/65 sm:px-6"
          data-testid="local-test-mode"
        >
          ローカル動作テスト · 本人確認は未実施 · 実際のメール・SMSは送信しません
        </p>
      )}
    </header>
  );
}

// Kept for existing detail pages; the shared layout now owns the visible header.
export function GuardianHeader() {
  const state = useContext(GuardianContext);
  return state ? null : <Header />;
}

export function ChildPicker() {
  const g = useGuardian();
  if (g.familyLoading && !g.me)
    return (
      <p className="py-4 text-sm" aria-busy="true">
        お子さんの情報を読み込み中
      </p>
    );
  if (g.familyError)
    return (
      <div>
        <ApiFailure error={g.familyError} retry={() => void g.reloadFamily()} />
        <Link href="/signup" className="text-sm text-calm underline">
          登録・同意の確認へ
        </Link>
      </div>
    );
  if (!g.me?.family.consentComplete)
    return (
      <p className="py-4">
        <Link className="text-calm underline" href="/consent">
          保護者の同意を確認してください
        </Link>
      </p>
    );
  if (!g.me.children.length)
    return (
      <p className="py-4" data-testid="guardian-no-children">
        お子さんはまだ登録されていません。{' '}
        <Link className="text-calm underline" href="/children">
          お子さんを登録する
        </Link>
      </p>
    );
  return (
    <label className="flex min-w-0 flex-wrap items-center gap-3 py-5 text-sm font-medium">
      お子さん
      <select
        className={`${field} sm:max-w-xs`}
        value={g.childId}
        onChange={(e) => g.selectChild(e.target.value)}
        data-testid="guardian-child-select"
      >
        {g.me.children.map((child) => (
          <option key={child.childId} value={child.childId}>
            {child.nickname}
          </option>
        ))}
      </select>
    </label>
  );
}

export function GuardianShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const [me, setMe] = useState<MeRes | null>(null);
  const [familyLoading, setFamilyLoading] = useState(true);
  const [familyError, setFamilyError] = useState<Error | null>(null);
  const [childId, selectChild] = useState('');
  const [notifications, setNotifications] = useState<NotificationsRes['items']>([]);
  const [noticesLoading, setNoticesLoading] = useState(true);
  const [noticesError, setNoticesError] = useState<Error | null>(null);
  const familyRun = useRef(0);
  const noticeRun = useRef(0);
  const reloadFamily = useCallback(async () => {
    const run = ++familyRun.current;
    setFamilyLoading(true);
    try {
      const next = await guardianRequest<MeRes>('/v1/me');
      if (run !== familyRun.current) return;
      setMe(next);
      setFamilyError(null);
      selectChild((id) =>
        next.children.some((child) => child.childId === id)
          ? id
          : (next.children[0]?.childId ?? ''),
      );
    } catch (error) {
      if (run !== familyRun.current) return;
      setMe(null);
      selectChild('');
      setFamilyError(error instanceof Error ? error : new Error('request_failed'));
    } finally {
      if (run === familyRun.current) setFamilyLoading(false);
    }
  }, []);
  const reloadNotices = useCallback(async () => {
    const run = ++noticeRun.current;
    setNoticesLoading(true);
    try {
      const items: NotificationsRes['items'] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const query = new URLSearchParams({
          pageSize: '100',
          ...(cursor ? { pageToken: cursor } : {}),
        });
        const page = await guardianRequest<NotificationsRes>(`/v1/notifications?${query}`);
        if (run !== noticeRun.current) return;
        items.push(...page.items);
        cursor = page.nextPageToken;
        if (cursor && seen.has(cursor)) throw new Error('invalid_page_cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      setNotifications(items);
      setNoticesError(null);
    } catch (error) {
      if (run !== noticeRun.current) return;
      if (error instanceof GuardianApiError && [401, 403].includes(error.status))
        setNotifications([]);
      setNoticesError(error instanceof Error ? error : new Error('request_failed'));
    } finally {
      if (run === noticeRun.current) setNoticesLoading(false);
    }
  }, []);
  useEffect(() => {
    void reloadFamily();
    void reloadNotices();
  }, [path, reloadFamily, reloadNotices]);
  useEffect(() => {
    const changed = () => {
      setMe(null);
      selectChild('');
      setNotifications([]);
      void reloadFamily();
      void reloadNotices();
    };
    window.addEventListener('mamori-guardian-changed', changed);
    return () => window.removeEventListener('mamori-guardian-changed', changed);
  }, [reloadFamily, reloadNotices]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void reloadNotices();
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [reloadNotices]);
  const crises = notifications.filter(
    (notice) => notice.kind === 'crisis' && !notice.acknowledgedAt,
  );
  return (
    <GuardianContext.Provider
      value={{
        me,
        familyLoading,
        familyError,
        childId,
        selectChild,
        reloadFamily,
        notifications,
        noticesLoading,
        noticesError,
        reloadNotices,
        acknowledgeNotice: (id, acknowledgedAt) =>
          setNotifications((items) =>
            items.map((item) => (item.id === id ? { ...item, acknowledgedAt } : item)),
          ),
      }}
    >
      <Header />
      {crises.length > 0 && (
        <aside
          role="alert"
          className="sticky top-0 z-30 border-b border-alert/30 bg-red-50"
          data-testid="crisis-banner"
        >
          <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-3 px-4 py-3 sm:px-6">
            <AlertTriangle className="mt-0.5 shrink-0 text-alert" size={20} aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-bold text-alert">
                安全に関する未確認のお知らせがあります（{crises.length}件）
              </p>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-2 text-sm">
                {crises.map((notice, i) => (
                  <li key={notice.id}>
                    <Link
                      className="underline"
                      href={`/notifications/${encodeURIComponent(notice.id)}`}
                    >
                      {me?.children.find((child) => child.childId === notice.childId)?.nickname ??
                        `お知らせ ${i + 1}`}
                      のお知らせを確認する
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </aside>
      )}
      {noticesError && path !== '/signup' && (
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <ApiFailure error={new Error('notice_unavailable')} retry={() => void reloadNotices()} />
        </div>
      )}
      {children}
    </GuardianContext.Provider>
  );
}
