'use client';

import { Button } from '@ijime/ui';
import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

export const PALETTE = [
  '#3b3a36',
  '#e5533d',
  '#f6a96b',
  '#f4c95d',
  '#7fb77e',
  '#2e8b57',
  '#6b9ac4',
  '#2f5f8f',
  '#8e6bc4',
  '#f2b8c6',
  '#8a5a3c',
  '#ffffff',
] as const;

export const PALETTE_NAMES: Record<(typeof PALETTE)[number], string> = {
  '#3b3a36': 'くろ',
  '#e5533d': 'あか',
  '#f6a96b': 'オレンジ',
  '#f4c95d': 'きいろ',
  '#7fb77e': 'みどり',
  '#2e8b57': 'ふかみどり',
  '#6b9ac4': 'みずいろ',
  '#2f5f8f': 'あお',
  '#8e6bc4': 'むらさき',
  '#f2b8c6': 'ピンク',
  '#8a5a3c': 'ちゃいろ',
  '#ffffff': 'しろ',
};

export type DrawingMode = 'drawing' | 'story' | 'self_portrait';

const CANVAS_LABEL: Record<DrawingMode, string> = {
  drawing: 'お絵かきキャンバス',
  story: 'お話の続きを描くキャンバス',
  self_portrait: '自分を描くキャンバス',
};

type Stroke = { color: string; width: number; points: { x: number; y: number }[] };

const MAX_EDGE = 1024;

export function exportPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const scale = Math.min(1, MAX_EDGE / Math.max(canvas.width, canvas.height));
  const out = document.createElement('canvas');
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
}

export function DrawingCanvas({
  onDone,
  doneLabel,
  mode = 'drawing',
}: {
  onDone: (png: Blob, strokeCount: number) => void;
  doneLabel?: string;
  mode?: DrawingMode;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].draw;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [eraser, setEraser] = useState(false);
  const [width, setWidth] = useState(8);
  const [count, setCount] = useState(0);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const s of [...strokes.current, ...(current.current ? [current.current] : [])]) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      s.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (s.points.length === 1) ctx.lineTo(s.points[0]!.x + 0.1, s.points[0]!.y);
      ctx.stroke();
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      redraw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [redraw]);

  const toPoint = (e: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const dpr = () =>
    canvasRef.current
      ? canvasRef.current.width / canvasRef.current.getBoundingClientRect().width
      : 1;

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="drawing-canvas"
      data-mode={mode}
      data-strokes={count}
    >
      <canvas
        ref={canvasRef}
        className="aspect-square w-full touch-none rounded-card bg-white shadow-soft"
        aria-label={CANVAS_LABEL[mode]}
        role="img"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          current.current = {
            color: eraser ? '#ffffff' : color,
            width: (eraser ? width * 3 : width) * dpr(),
            points: [toPoint(e)],
          };
          redraw();
        }}
        onPointerMove={(e) => {
          if (!current.current) return;
          current.current.points.push(toPoint(e));
          redraw();
        }}
        onPointerUp={() => {
          if (!current.current) return;
          strokes.current.push(current.current);
          current.current = null;
          setCount(strokes.current.length);
          redraw();
        }}
        onPointerCancel={() => {
          current.current = null;
          redraw();
        }}
      />
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="道具">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={PALETTE_NAMES[c]}
            aria-pressed={!eraser && color === c}
            onClick={() => {
              setColor(c);
              setEraser(false);
            }}
            className={`h-9 w-9 rounded-full border-2 ${!eraser && color === c ? 'border-ink scale-110' : 'border-cream-deep'}`}
            style={{ background: c }}
          />
        ))}
        <Button
          variant={eraser ? 'primary' : 'secondary'}
          size="md"
          aria-pressed={eraser}
          onClick={() => setEraser((v) => !v)}
        >
          {copy.eraser}
        </Button>
        <Button
          variant="secondary"
          size="md"
          onClick={() => {
            strokes.current.pop();
            setCount(strokes.current.length);
            redraw();
          }}
          disabled={count === 0}
        >
          {copy.undo}
        </Button>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <span className="sr-only">太さ</span>
          <input
            type="range"
            min={3}
            max={24}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
            aria-label="太さ"
          />
        </label>
      </div>
      <Button
        size="xl"
        data-testid="draw-done"
        disabled={count === 0}
        onClick={async () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          onDone(await exportPng(canvas), strokes.current.length);
        }}
      >
        {doneLabel ?? copy.done}
      </Button>
    </div>
  );
}
