'use client';

import { useEffect, useRef } from 'react';

import { SOUND_EVENT } from './StageVideo';

// Light background loop for the whole page, driven by the SOUND toggle. Starts only after the
// visitor turns sound on (browsers block autoplay with audio), fades out when turned off.
const FADE_MS = 600;
const STEP_MS = 40;
const VOLUME = 0.55;

export function BackgroundMusic({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    let timer = 0;
    // Timer-driven fade: requestAnimationFrame can stall in background or low-power tabs,
    // which would leave the track playing at volume 0.
    const fadeTo = (target: number, done?: () => void) => {
      window.clearInterval(timer);
      const from = a.volume;
      const t0 = Date.now();
      timer = window.setInterval(() => {
        const f = Math.min(1, (Date.now() - t0) / FADE_MS);
        a.volume = from + (target - from) * f;
        if (f >= 1) {
          window.clearInterval(timer);
          done?.();
        }
      }, STEP_MS);
    };
    const sync = () => {
      const on = document.documentElement.dataset['sound'] === 'on';
      if (on) {
        if (a.paused) a.volume = 0;
        void a.play().catch(() => undefined);
        fadeTo(VOLUME);
      } else {
        fadeTo(0, () => a.pause());
      }
    };
    window.addEventListener(SOUND_EVENT, sync);
    return () => {
      window.removeEventListener(SOUND_EVENT, sync);
      window.clearInterval(timer);
    };
  }, []);
  return <audio ref={ref} src={src} loop preload="none" data-media="music" />;
}
