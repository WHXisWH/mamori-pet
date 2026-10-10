'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { useChildStore } from '@/lib/store';

const ALWAYS_OPEN = ['/help', '/safe', '/offline'];

export function OnboardingGuard({ children }: { children: ReactNode }) {
  const { hydrated, paired, assented, characterId } = useChildStore();
  const pathname = usePathname();
  const router = useRouter();
  const reconnect =
    pathname === '/pair' &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('reconnect') === '1';

  useEffect(() => {
    if (!hydrated || ALWAYS_OPEN.includes(pathname)) return;
    const target = !paired ? '/pair' : !assented ? '/welcome' : !characterId ? '/choose' : null;
    if (target && pathname !== target) router.replace(target);
    if (
      !target &&
      !reconnect &&
      ['/pair', '/welcome', '/choose'].includes(pathname) &&
      pathname !== '/choose'
    ) {
      router.replace('/');
    }
  }, [hydrated, paired, assented, characterId, pathname, reconnect, router]);

  if (!hydrated && !ALWAYS_OPEN.includes(pathname)) {
    return (
      <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <div className="h-10 w-10 animate-bob rounded-full bg-cream-deep" />
      </div>
    );
  }
  return <>{children}</>;
}
