import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { LocalPreviewReset } from '../../../../packages/ui/src/components/LocalPreviewReset';

import { RegisterServiceWorker } from '@/components/RegisterServiceWorker';
import { GuardianShell } from '@/components/GuardianShell';

import './globals.css';

export const metadata: Metadata = {
  title: 'まもりペット 保護者',
  description: 'お子さんの元気度と、お知らせを受け取ります',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'まもりペット 保護者' },
  icons: { icon: '/icons/icon.svg', apple: '/icons/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#f7f7f5',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">
        <LocalPreviewReset enabled={process.env.NEXT_PUBLIC_LOCAL_DEMO === '1'} target="/signup">
          <GuardianShell>{children}</GuardianShell>
          <RegisterServiceWorker />
        </LocalPreviewReset>
      </body>
    </html>
  );
}
