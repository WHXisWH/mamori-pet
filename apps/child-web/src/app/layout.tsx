import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { LocalPreviewReset } from '@ijime/ui';

import { OnboardingGuard } from '@/components/OnboardingGuard';
import { RegisterServiceWorker } from '@/components/RegisterServiceWorker';

import './globals.css';

export const metadata: Metadata = {
  title: 'まもりペット',
  description: 'まいにち いっしょの ペット',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'まもりペット' },
  icons: { icon: '/icons/icon.svg', apple: '/icons/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#fff8f0',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="ja" data-grade="high">
      <body className="min-h-dvh antialiased">
        <LocalPreviewReset enabled={process.env.NEXT_PUBLIC_LOCAL_DEMO === '1'} target="/pair">
          <OnboardingGuard>{children}</OnboardingGuard>
          <RegisterServiceWorker />
        </LocalPreviewReset>
      </body>
    </html>
  );
}
