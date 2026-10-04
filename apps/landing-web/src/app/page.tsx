import { Button, PetAvatar } from '@ijime/ui';

import { SoundToggle } from '@/components/cinema/StageVideo';
import { availableMedia } from '@/lib/media';

import { Characters } from '@/components/Characters';
import { Hero } from '@/components/Hero';
import { Reveal } from '@/components/Reveal';
import { Guardians, Promise, Safety, Tech, Ways } from '@/components/Sections';
import { Story } from '@/components/Story';

const CHILD_APP_URL = process.env.NEXT_PUBLIC_CHILD_APP_URL ?? 'http://localhost:3000';
const GUARDIAN_APP_URL = process.env.NEXT_PUBLIC_GUARDIAN_APP_URL ?? 'http://localhost:3001';

export default function LandingPage() {
  const media = availableMedia();
  const hasMedia = Object.keys(media).length > 0;
  return (
    <>
      <header className="fixed inset-x-0 top-0 z-40 px-3 pt-[max(8px,calc((var(--bar-h)-56px)/2))] md:px-6">
        <nav
          className="site-nav mx-auto flex max-w-6xl items-center justify-between rounded-full py-1 pr-1 pl-4 md:pl-6"
          aria-label="メイン"
        >
          <a
            href="#top"
            className="flex items-center gap-2 font-display text-base font-bold tracking-[0.2em]"
          >
            <PetAvatar characterId="moko" expression="happy" size={32} animate={false} />
            まもりペット
          </a>
          <ul className="hidden gap-7 text-xs font-bold tracking-[0.2em] opacity-85 md:flex">
            <li>
              <a href="#story" className="hover:opacity-100">
                ものがたり
              </a>
            </li>
            <li>
              <a href="#characters" className="hover:opacity-100">
                なかま
              </a>
            </li>
            <li>
              <a href="#ways" className="hover:opacity-100">
                あそびかた
              </a>
            </li>
            <li>
              <a href="#guardians" className="hover:opacity-100">
                保護者の方へ
              </a>
            </li>
          </ul>
          <a href={GUARDIAN_APP_URL}>
            <Button size="md" variant="calm">
              保護者登録
            </Button>
          </a>
        </nav>
      </header>

      <main id="top">
        <Hero video={media.s0} />
        <Story media={media} />
        <Characters />
        <Ways />
        <Guardians />
        <Safety />
        <Promise />
        <Tech />

        <section className="py-24" aria-labelledby="cta-title">
          <div className="mx-auto max-w-4xl px-4 text-center md:px-8">
            <Reveal>
              <div className="flex justify-center gap-[-20px]">
                <PetAvatar characterId="pokke" expression="celebrate" size={120} />
                <PetAvatar characterId="moko" expression="happy" size={140} />
                <PetAvatar characterId="nami" expression="together" size={120} />
              </div>
              <h2 id="cta-title" className="mt-6 font-display text-3xl font-bold md:text-4xl">
                まず、保護者の方から。
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-lg leading-relaxed text-ink-soft">
                保護者が登録して同意したあと、お子さんの端末とペアリングします。お子さんには、はじめに「約束のカード」を見せます。
              </p>
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                <a href={GUARDIAN_APP_URL}>
                  <Button size="xl" variant="calm">
                    保護者として はじめる
                  </Button>
                </a>
                <a href={`${CHILD_APP_URL}/pair`}>
                  <Button size="xl" variant="secondary">
                    こどもの端末で つなぐ
                  </Button>
                </a>
              </div>
            </Reveal>
          </div>
        </section>
      </main>

      {hasMedia && <SoundToggle />}

      <footer className="border-t border-cream-deep bg-white py-10 text-sm text-ink-soft">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 md:grid-cols-3 md:px-8">
          <div>
            <p className="font-display text-base font-bold text-ink">まもりペット</p>
            <p className="mt-2 leading-relaxed">
              医療診断や心理カウンセリングの代わりにはなりません。人による24時間の見守りは行っていません。
            </p>
          </div>
          <div>
            <p className="font-bold text-ink">相談窓口</p>
            <ul className="mt-2 space-y-1">
              <li>24時間子供SOSダイヤル：0120-0-78310</li>
              <li>チャイルドライン：0120-99-7777</li>
              <li>児童相談所虐待対応ダイヤル：189</li>
              <li>緊急時：110 / 119</li>
            </ul>
          </div>
          <div>
            <p className="font-bold text-ink">Mamori Pet</p>
            <p className="mt-2 leading-relaxed">
              An AI companion pet for Japanese children that listens first and connects them to a
              trusted adult only when it matters. Built with Google ADK and Gemini, in Tokyo.
            </p>
            <p className="mt-3 text-xs">
              第5回 Agentic AI Hackathon with Google Cloud エントリー作品
            </p>
          </div>
        </div>
      </footer>
    </>
  );
}
