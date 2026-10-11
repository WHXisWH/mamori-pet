'use client';

import { useEffect, useRef, useState } from 'react';

import { prefersReducedMotion } from './motion';

export const SOUND_EVENT = 'mamori:sound';

export function StageVideo({
  src,
  poster,
  active = true,
  className = 'absolute inset-0 h-full w-full object-cover',
}: {
  src: string;
  poster?: string | undefined;
  active?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // The page's background music carries the sound; the clip's own audio stays muted.
    const sync = () => {
      v.muted = true;
    };
    sync();
    window.addEventListener(SOUND_EVENT, sync);
    if (prefersReducedMotion()) v.pause();
    else if (active) void v.play().catch(() => undefined);
    else v.pause();
    return () => window.removeEventListener(SOUND_EVENT, sync);
  }, [active]);

  return (
    <video
      ref={ref}
      data-media="video"
      src={src}
      poster={poster}
      muted
      loop
      playsInline
      preload="metadata"
      className={className}
    />
  );
}

export function SoundToggle() {
  const [on, setOn] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? '音を消す' : '音を出す'}
      onClick={() => {
        const next = !on;
        setOn(next);
        document.documentElement.dataset['sound'] = next ? 'on' : 'off';
        window.dispatchEvent(new Event(SOUND_EVENT));
      }}
      className="fixed right-4 bottom-4 z-50 flex h-11 items-center gap-2 rounded-full bg-film/70 px-4 text-xs tracking-[0.2em] text-[#f3ede2] backdrop-blur-md transition hover:bg-film/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f3ede2]"
    >
      <span aria-hidden="true" className="flex h-3 items-end gap-[2px]">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`w-[2px] rounded-full bg-current ${on ? 'animate-[cue_0.9s_ease-in-out_infinite]' : ''}`}
            style={{ height: `${6 + i * 3}px`, animationDelay: `${i * 0.15}s` }}
          />
        ))}
      </span>
      SOUND {on ? 'ON' : 'OFF'}
    </button>
  );
}
