'use client';

import { IconButton } from '@ijime/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

import { HelpButton } from './HelpButton';
import { LockGate } from './LockGate';

export function AppShell({
  children,
  back,
  left,
  title,
  hideHelp = false,
  requireLock = true,
  fillViewport = false,
  className = '',
}: {
  children: ReactNode;
  back?: string;
  left?: ReactNode;
  title?: string;
  hideHelp?: boolean;
  requireLock?: boolean;
  fillViewport?: boolean;
  className?: string;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const router = useRouter();
  const copy = COPY[gradeBand];

  useEffect(() => {
    document.documentElement.dataset['grade'] = gradeBand;
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Tokyo' })
        .format(new Date())
        .replace(/\D/g, ''),
    );
    document.documentElement.dataset['night'] = String(hour >= 23 || hour < 5);
  }, [gradeBand]);

  return (
    <div className={`flex flex-col ${fillViewport ? 'h-dvh' : 'min-h-dvh'} ${className}`}>
      <header className="sticky top-0 z-30 shrink-0 bg-cream [html[data-night=true]_&]:bg-night">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <div className="flex items-center gap-2">
            {back !== undefined ? (
              <IconButton
                label={copy.back}
                onClick={() => (back ? router.push(back) : router.back())}
              >
                <span aria-hidden="true" className="text-xl">
                  ←
                </span>
              </IconButton>
            ) : (
              left
            )}
            {title && <h1 className="font-display text-lg font-bold">{title}</h1>}
          </div>
          {!hideHelp && <HelpButton label={copy.help} />}
        </div>
        {process.env.NEXT_PUBLIC_LOCAL_DEMO === '1' && (
          <p
            data-testid="local-test-mode"
            className="mx-auto w-full max-w-md px-4 pb-2 text-xs leading-relaxed text-ink-soft"
          >
            ローカル体験版 · AI の返答はテスト用です。実際のメール・SMSは送信しません。
          </p>
        )}
      </header>
      <div className={fillViewport ? 'flex min-h-0 flex-1 flex-col overflow-y-auto' : 'flex-1'}>
        {requireLock ? <LockGate>{children}</LockGate> : children}
      </div>
    </div>
  );
}

export function SettingsLink() {
  const gradeBand = useChildStore((s) => s.gradeBand);
  return (
    <Link
      href="/settings"
      aria-label={COPY[gradeBand].settingsLabel}
      className="grade-tap tap-target inline-flex items-center justify-center rounded-full bg-white text-xl shadow-soft hover:bg-cream-deep focus-visible:outline-4 focus-visible:outline-calm-deep"
    >
      <span aria-hidden="true">⚙️</span>
    </Link>
  );
}
