'use client';

import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';

import { whenIntroDone } from './Intro';
import { prefersReducedMotion } from './motion';

export function RevealLines({
  lines,
  as: Tag = 'span',
  className = '',
  id,
  afterIntro = false,
  baseDelayMs = 0,
}: {
  lines: ReactNode[];
  as?: ElementType;
  className?: string;
  id?: string;
  afterIntro?: boolean;
  baseDelayMs?: number;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
      setRevealed(true);
      return;
    }
    let introDone = !afterIntro;
    let inView = false;
    const maybe = () => {
      if (introDone && inView) setRevealed(true);
    };
    const stopWaiting = afterIntro
      ? whenIntroDone(() => {
          introDone = true;
          maybe();
        })
      : () => undefined;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          inView = true;
          maybe();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => {
      stopWaiting();
      io.disconnect();
    };
  }, [afterIntro]);

  return (
    <Tag
      ref={ref}
      id={id}
      className={`${className} ${revealed ? 'is-revealed' : ''}`}
      style={{ ['--base-delay' as string]: `${baseDelayMs}ms` }}
    >
      {lines.map((line, i) => (
        <span key={i} className="block overflow-hidden pb-[0.08em]">
          <span className="reveal-line" style={{ ['--i' as string]: i }}>
            {line}
          </span>
        </span>
      ))}
    </Tag>
  );
}
