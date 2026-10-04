'use client';

import type { Expression } from '@ijime/api-types';
import { Button } from '@ijime/ui';
import { useEffect, useState } from 'react';

import { DustMotes } from './cinema/DustMotes';
import { whenIntroDone } from './cinema/Intro';
import { prefersReducedMotion } from './cinema/motion';
import { RevealLines } from './cinema/RevealLines';
import { RoomScene } from './cinema/scenes';
import { StageVideo } from './cinema/StageVideo';
import type { MediaSource } from '@/lib/media-shared';

const CYCLE: Expression[] = ['happy', 'caring', 'together', 'happy', 'celebrate'];

export function Hero({ video }: { video?: MediaSource | undefined }) {
  const [i, setI] = useState(0);
  const [rolling, setRolling] = useState(false);

  useEffect(() => whenIntroDone(() => setRolling(true)), []);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const t = setInterval(() => setI((v) => (v + 1) % CYCLE.length), 3600);
    return () => clearInterval(t);
  }, []);

  return (
    <section
      aria-labelledby="hero-title"
      data-scroll
      data-watch
      className={`letterbox is-framed relative h-[100svh] min-h-[620px] overflow-hidden bg-film ${rolling ? 'is-rolling' : ''}`}
    >
      <div className="hero-cam absolute inset-0">
        <div className="camera" style={{ ['--fx' as string]: '64%', ['--fy' as string]: '72%' }}>
          {video ? (
            <StageVideo src={video.src} poster={video.poster} className="hero-video" />
          ) : (
            <div data-media="scene" className="absolute inset-0">
              <RoomScene
                uid="hero"
                time="afternoon"
                pet={{
                  characterId: 'moko',
                  expression: CYCLE[i]!,
                  x: 1070,
                  y: 700,
                  size: 250,
                  mobile: { x: 800, y: 746, size: 222 },
                  testId: 'hero-avatar',
                }}
              />
            </div>
          )}
        </div>
        <div
          aria-hidden="true"
          className="animate-leak pointer-events-none absolute -inset-[20%] mix-blend-screen"
          style={{
            background:
              'radial-gradient(40% 35% at 70% 20%, rgba(255,196,120,0.55), transparent 70%), radial-gradient(30% 30% at 15% 80%, rgba(255,150,120,0.25), transparent 70%)',
          }}
        />
        <DustMotes count={80} />
        <div aria-hidden="true" className="vignette absolute inset-0" />
        <div
          aria-hidden="true"
          className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(14,15,20,0.8)_0%,rgba(14,15,20,0.5)_34%,transparent_58%)] md:bg-[linear-gradient(100deg,rgba(14,15,20,0.74)_0%,rgba(14,15,20,0.38)_40%,transparent_62%)]"
        />
        <div aria-hidden="true" className="hero-fade absolute inset-0 bg-film" />
      </div>

      <div className="hero-copy relative z-10 mx-auto flex h-full max-w-6xl flex-col justify-start px-5 pt-[calc(var(--bar-h)+76px)] md:justify-center md:px-10 md:pt-0">
        <p className="flex items-center gap-3 font-display text-xs tracking-[0.6em] text-[#f3ede2]/80">
          <span aria-hidden="true" className="h-px w-8 bg-[#f3ede2]/50" />
          まもりペット
        </p>
        <RevealLines
          as="h1"
          id="hero-title"
          afterIntro
          className="mt-5 max-w-3xl font-display text-[clamp(1.85rem,4.2vw,3.75rem)] leading-[1.22] font-bold tracking-[0.02em] text-[#fbf5ec] [text-shadow:0_2px_24px_rgba(0,0,0,0.35)] sm:[&_.reveal-line]:whitespace-nowrap"
          lines={['「おかえり」って、', '言ってくれる相棒。']}
        />
        <RevealLines
          as="p"
          afterIntro
          baseDelayMs={500}
          className="phrase mt-5 max-w-xl text-[15px] leading-relaxed text-[#f3ede2]/85 md:mt-6 md:text-lg"
          lines={[
            '日本の小学生・中学生のための AI 電子ペット。',
            'おはようから おやすみまで、毎日となりにいます。',
          ]}
        />
        <div className="mt-6 flex flex-row gap-3 md:mt-9">
          <a href="#characters">
            <Button variant="primary" size="lg" className="md:!px-8 md:!py-4 md:!text-xl">
              なかまを見る
            </Button>
          </a>
          <a href="#guardians">
            <Button
              variant="ghost"
              size="lg"
              className="border border-[#f3ede2]/40 !text-[#f3ede2] hover:!bg-white/10 md:!px-8 md:!py-4 md:!text-xl"
            >
              保護者の方へ
            </Button>
          </a>
        </div>
      </div>

      <a
        href="#story"
        className="absolute bottom-[calc(var(--bar)+14px)] left-1/2 z-30 hidden -translate-x-1/2 flex-col items-center gap-2 text-[10px] tracking-[0.4em] text-[#f3ede2]/75 md:flex"
        aria-label="スクロールして続きを見る"
      >
        <span>SCROLL</span>
        <span aria-hidden="true" className="animate-cue block h-8 w-px bg-[#f3ede2]/70" />
      </a>
    </section>
  );
}
