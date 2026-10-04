'use client';

import { useEffect, useState } from 'react';

import { prefersReducedMotion } from './motion';

const KEY = 'mamori-intro-seen';
export const INTRO_MS = 2600;
export const INTRO_EVENT = 'mamori:intro-done';

let finished = false;

function finishIntro() {
  finished = true;
  window.dispatchEvent(new Event(INTRO_EVENT));
}

export function whenIntroDone(cb: () => void): () => void {
  if (finished) {
    cb();
    return () => undefined;
  }
  const handler = () => cb();
  window.addEventListener(INTRO_EVENT, handler, { once: true });
  return () => window.removeEventListener(INTRO_EVENT, handler);
}

export function introWillPlay(): boolean {
  if (typeof window === 'undefined') return false;
  if (prefersReducedMotion()) return false;
  if (new URLSearchParams(window.location.search).has('nointro')) return false;
  try {
    return sessionStorage.getItem(KEY) !== '1';
  } catch {
    return false;
  }
}

export function Intro() {
  const [phase, setPhase] = useState<'idle' | 'title' | 'open' | 'done'>('idle');

  useEffect(() => {
    if (!introWillPlay()) {
      setPhase('done');
      finishIntro();
      return;
    }
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      // ignore
    }
    setPhase('title');
    const t1 = setTimeout(() => setPhase('open'), INTRO_MS - 900);
    const t2 = setTimeout(() => {
      setPhase('done');
      finishIntro();
    }, INTRO_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  if (phase === 'done' || phase === 'idle') return null;

  return (
    <div
      aria-hidden="true"
      data-testid="intro"
      className="pointer-events-none fixed inset-0 z-[70] flex items-center justify-center"
    >
      <div
        className="absolute inset-x-0 top-0 bg-film transition-[height] duration-[900ms] ease-[cubic-bezier(0.7,0,0.2,1)]"
        style={{ height: phase === 'open' ? '0%' : '50.5%' }}
      />
      <div
        className="absolute inset-x-0 bottom-0 bg-film transition-[height] duration-[900ms] ease-[cubic-bezier(0.7,0,0.2,1)]"
        style={{ height: phase === 'open' ? '0%' : '50.5%' }}
      />
      <div
        className={`relative flex flex-col items-center gap-4 text-[#f3ede2] transition-opacity duration-500 ${
          phase === 'open' ? 'opacity-0' : 'opacity-100'
        }`}
      >
        <span className="is-revealed font-display text-3xl tracking-[0.5em] md:text-4xl">
          {'まもりペット'.split('').map((ch, i) => (
            <span key={i} className="reveal-line" style={{ ['--i' as string]: i }}>
              {ch}
            </span>
          ))}
        </span>
        <span className="h-px w-24 origin-center animate-[fade-up_1.4s_ease-out_both] bg-[#f3ede2]/50" />
      </div>
    </div>
  );
}
