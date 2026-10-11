'use client';

import { useRouter } from 'next/navigation';

import { AppShell } from '@/components/AppShell';
import { PairingCodeInput } from '@/components/PairingCodeInput';
import { useChildStore } from '@/lib/store';
import { API_BASE_URL } from '@/lib/api';
import { signInPairedChild } from '@/lib/auth';
import type { PairRes } from '@ijime/api-types';

export default function PairPage() {
  const pair = useChildStore((s) => s.pair);
  const router = useRouter();
  return (
    <AppShell requireLock={false}>
      {process.env.NEXT_PUBLIC_LOCAL_DEMO === '1' && (
        <p role="status" className="mx-auto max-w-md px-4 py-4 text-sm text-ink-soft">
          ローカル体験版です。本番の 本人確認は おこなっていません。
        </p>
      )}
      <PairingCodeInput
        onSubmit={async (code) => {
          try {
            if (process.env.NEXT_PUBLIC_LOCAL_DEMO === '1' && code === '123456') {
              await signInPairedChild('local-demo:c_dev', 'c_dev');
              useChildStore.getState().reset();
              pair('c_dev');
            } else {
              const response = await fetch(`${API_BASE_URL}/v1/child/pair`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code }),
              });
              if (!response.ok) {
                const body = (await response.json().catch(() => null)) as {
                  error?: { code?: string };
                } | null;
                return body?.error?.code === 'PAIRING_CODE_EXPIRED' ? 'expired' : false;
              }
              const result = (await response.json()) as PairRes;
              await signInPairedChild(result.customToken, result.childId);
              useChildStore.getState().reset();
              pair(result.childId);
            }
            router.replace('/welcome');
            return true;
          } catch {
            return false;
          }
        }}
      />
    </AppShell>
  );
}
