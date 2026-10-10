'use client';

import Lenis from 'lenis';
import { useEffect } from 'react';

import { prefersReducedMotion, viewProgress } from './motion';

// Height of the fixed site header plus breathing room, so anchored sections start below it.
const ANCHOR_OFFSET_PX = 88;

export function CinemaRuntime() {
  useEffect(() => {
    const root = document.documentElement;
    const reduced = prefersReducedMotion();
    root.dataset['motion'] = reduced ? 'reduced' : 'full';

    let lenis: Lenis | null = null;
    if (!reduced) {
      // anchors: land sections below the fixed header; lerp: a little quicker so the wheel feels direct
      lenis = new Lenis({
        autoRaf: true,
        anchors: { offset: -ANCHOR_OFFSET_PX },
        lerp: 0.11,
        smoothWheel: true,
      });
    }

    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let dirty = true;
    let frame = 0;

    // Only elements within two viewports of the screen get measured each frame.
    const nearby = new Set<HTMLElement>();
    const near = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) nearby.add(e.target as HTMLElement);
          else nearby.delete(e.target as HTMLElement);
        }
        dirty = true;
      },
      { rootMargin: '100% 0px 100% 0px' },
    );
    const tracked = () => {
      near.disconnect();
      nearby.clear();
      for (const el of document.querySelectorAll<HTMLElement>('[data-scroll]')) near.observe(el);
    };
    tracked();

    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      targetX = (e.clientX / window.innerWidth) * 2 - 1;
      targetY = (e.clientY / window.innerHeight) * 2 - 1;
      dirty = true;
    };
    const onScroll = () => {
      dirty = true;
    };
    const onResize = () => {
      tracked();
      dirty = true;
    };

    const tick = () => {
      frame = requestAnimationFrame(tick);
      if (!reduced) {
        x += (targetX - x) * 0.06;
        y += (targetY - y) * 0.06;
        if (Math.abs(targetX - x) > 0.001 || Math.abs(targetY - y) > 0.001) {
          root.style.setProperty('--mx', x.toFixed(4));
          root.style.setProperty('--my', y.toFixed(4));
        }
      }
      if (!dirty) return;
      dirty = false;
      const vh = window.innerHeight;
      root.dataset['scrolled'] = window.scrollY > 40 ? 'true' : 'false';
      for (const el of nearby) {
        const rect = el.getBoundingClientRect();
        el.style.setProperty('--p', reduced ? '0.5' : viewProgress(rect, vh).toFixed(4));
      }
    };
    frame = requestAnimationFrame(tick);

    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    const mo = new MutationObserver(onResize);
    mo.observe(document.body, { childList: true, subtree: true });

    const watcher = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          (e.target as HTMLElement).dataset['offscreen'] = e.isIntersecting ? 'false' : 'true';
        }
      },
      { rootMargin: '10% 0px' },
    );
    for (const el of document.querySelectorAll('[data-watch]')) watcher.observe(el);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      mo.disconnect();
      near.disconnect();
      watcher.disconnect();
      lenis?.destroy();
    };
  }, []);

  return <div aria-hidden="true" className="film-grain" />;
}
