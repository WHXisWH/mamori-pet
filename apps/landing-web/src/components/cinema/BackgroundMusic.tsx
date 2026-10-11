'use client';

import { useEffect, useRef } from 'react';

import { SOUND_EVENT } from './StageVideo';

// Light background loop for the whole page, driven by the SOUND toggle. Starts only after the
// visitor turns sound on (browsers block autoplay with audio), fades out when turned off.
const FADE_MS = 600;
const VOLUME = 0.55;

export function BackgroundMusic({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    let fade = 0;
    const sync = () => {
      const on = document.documentElement.dataset['sound'] === 'on';
      cancelAnimationFrame(fade);
      if (on) {
        a.volume = 0;
        void a.play().catch(() => undefined);
        const t0 = performance.now();
        const up = (t: number) => {
          a.volume = Math.min(VOLUME, (VOLUME * (t - t0)) / FADE_MS);
          if (a.volume < VOLUME) fade = requestAnimationFrame(up);
        };
        fade = requestAnimationFrame(up);
      } else {
        const v0 = a.volume;
        const t0 = performance.now();
        const down = (t: number) => {
          a.volume = Math.max(0, v0 * (1 - (t - t0) / FADE_MS));
          if (a.volume > 0) fade = requestAnimationFrame(down);
          else a.pause();
        };
        fade = requestAnimationFrame(down);
      }
    };
    window.addEventListener(SOUND_EVENT, sync);
    return () => {
      window.removeEventListener(SOUND_EVENT, sync);
      cancelAnimationFrame(fade);
    };
  }, []);
  return <audio ref={ref} src={src} loop preload="none" data-media="music" />;
}
