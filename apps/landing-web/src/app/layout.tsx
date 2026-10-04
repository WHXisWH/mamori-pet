import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';

import { CinemaRuntime } from '@/components/cinema/CinemaRuntime';
import { Intro } from '@/components/cinema/Intro';

import { maru, mincho } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'まもりペット — 「おかえり」って言ってくれる相棒',
  description:
    '日本の小学生・中学生のための AI 電子ペット。おはようから おやすみまで、毎日となりにいます。',
  icons: { icon: '/icons/icon.svg' },
  openGraph: {
    title: 'まもりペット',
    description: 'おはようから おやすみまで、毎日となりにいる AI ペット',
    locale: 'ja_JP',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#0e0f14',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();
  return (
    <html lang="ja" className={`${mincho.variable} ${maru.variable}`}>
      <body className="min-h-dvh antialiased">
        <Intro />
        {children}
        <CinemaRuntime />
      </body>
    </html>
  );
}
