'use client';

import { useEffect } from 'react';
import { useChildStore } from '@/lib/store';
import { refreshChildPush } from '@/lib/push';

export function RegisterServiceWorker() {
  const childId = useChildStore((s) => s.childId);
  const hydrated = useChildStore((s) => s.hydrated);
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!hydrated || !('serviceWorker' in navigator)) return;
    const refresh = () => {
      void refreshChildPush(childId).catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [childId, hydrated]);
  return null;
}
