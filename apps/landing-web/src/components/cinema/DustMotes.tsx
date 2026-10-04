'use client';

import { useEffect, useRef } from 'react';

import { prefersReducedMotion } from './motion';

type Mote = { x: number; y: number; r: number; vx: number; vy: number; a: number; phase: number };

export function DustMotes({
  count = 70,
  color = '255, 240, 214',
  className = '',
}: {
  count?: number;
  color?: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || prefersReducedMotion()) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0;
    let h = 0;
    let motes: Mote[] = [];
    let visible = true;
    let frame = 0;

    const spawn = (anywhere: boolean): Mote => ({
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 10,
      r: (0.5 + Math.random() * 1.8) * dpr,
      vx: (Math.random() - 0.3) * 0.12 * dpr,
      vy: -(0.05 + Math.random() * 0.18) * dpr,
      a: 0.25 + Math.random() * 0.6,
      phase: Math.random() * Math.PI * 2,
    });

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, Math.round(rect.width * dpr));
      h = Math.max(1, Math.round(rect.height * dpr));
      canvas.width = w;
      canvas.height = h;
      motes = Array.from({ length: count }, () => spawn(true));
    };

    const draw = (t: number) => {
      frame = requestAnimationFrame(draw);
      if (!visible) return;
      ctx.clearRect(0, 0, w, h);
      for (const m of motes) {
        m.x += m.vx + Math.sin(t / 2400 + m.phase) * 0.08 * dpr;
        m.y += m.vy;
        if (m.y < -10 || m.x < -10 || m.x > w + 10) Object.assign(m, spawn(false));
        const flicker = 0.55 + 0.45 * Math.sin(t / 900 + m.phase);
        ctx.beginPath();
        ctx.fillStyle = `rgba(${color}, ${(m.a * flicker).toFixed(3)})`;
        ctx.shadowColor = `rgba(${color}, 0.9)`;
        ctx.shadowBlur = 6 * dpr;
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      visible = e?.isIntersecting ?? true;
    });
    io.observe(canvas);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      io.disconnect();
    };
  }, [count, color]);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 h-full w-full mix-blend-screen ${className}`}
    />
  );
}
