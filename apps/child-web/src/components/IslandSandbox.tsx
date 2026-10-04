'use client';

import type { IslandCatalogItem, IslandItem } from '@ijime/api-types';
import { client } from '@ijime/config';
import { Button } from '@ijime/ui';
import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { IslandGround, IslandSprite } from '@/components/island/sprites';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

const MAX_ITEMS = 60;
const KEY_STEP = client.islandKeyStep;

function clamp01(n: number): number {
  return Number(Math.min(1, Math.max(0, n)).toFixed(3));
}

export function IslandSandbox({
  catalog,
  initial,
  season = 'spring',
  stage = 1,
  busy = false,
  onSave,
}: {
  catalog: IslandCatalogItem[];
  initial: { items: IslandItem[]; selfFigureId?: string };
  season?: string;
  stage?: number;
  busy?: boolean;
  onSave: (scene: { selfFigureId?: string; items: IslandItem[] }) => void;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].island;
  const [items, setItems] = useState<IslandItem[]>(initial.items);
  const [selected, setSelected] = useState<string | null>(null);
  const [selfId, setSelfId] = useState<string | null>(initial.selfFigureId ?? null);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const seq = useRef(0);

  const labelOf = (catalogId: string) =>
    catalog.find((c) => c.catalogId === catalogId)?.label ?? catalogId;

  const add = (c: IslandCatalogItem) => {
    if (c.locked || items.length >= MAX_ITEMS) return;
    seq.current += 1;
    const id = `fig_${Date.now().toString(36)}_${seq.current}`;
    const n = items.length;
    const x = Number((0.25 + ((n * 0.17) % 0.5)).toFixed(3));
    const y = Number((0.35 + ((n * 0.23) % 0.4)).toFixed(3));
    setItems((it) => [
      ...it,
      { id, catalogId: c.catalogId, category: c.category, x, y, rotation: 0, layer: it.length + 1 },
    ]);
    setSelected(id);
  };

  const update = (id: string, patch: Partial<IslandItem>) =>
    setItems((it) => it.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const remove = (id: string) => {
    setItems((it) => it.filter((x) => x.id !== id));
    if (selfId === id) setSelfId(null);
    if (selected === id) setSelected(null);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    update(drag.current.id, {
      x: clamp01((e.clientX - rect.left) / rect.width - drag.current.dx),
      y: clamp01((e.clientY - rect.top) / rect.height - drag.current.dy),
    });
  };

  const onItemKey = (e: KeyboardEvent<HTMLButtonElement>, it: IslandItem) => {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_STEP, 0],
      ArrowRight: [KEY_STEP, 0],
      ArrowUp: [0, -KEY_STEP],
      ArrowDown: [0, KEY_STEP],
    };
    const move = moves[e.key];
    if (move) {
      e.preventDefault();
      setSelected(it.id);
      update(it.id, { x: clamp01(it.x + move[0]), y: clamp01(it.y + move[1]) });
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(it.id);
    }
  };

  const sel = items.find((i) => i.id === selected);

  return (
    <div
      className="flex flex-col gap-3"
      data-testid="island-sandbox"
      data-items={items.length}
      data-self={selfId ?? ''}
    >
      <p className="text-sm leading-relaxed text-ink-soft" data-testid="island-keyboard-help">
        {copy.keyboardHelp}
      </p>
      <div
        ref={stageRef}
        className="relative aspect-[4/3] w-full touch-none overflow-hidden rounded-card bg-[#a8d8f5] shadow-soft"
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerLeave={() => (drag.current = null)}
        role="group"
        aria-label={copy.stageLabel}
      >
        <IslandGround
          stage={stage}
          season={season}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
        {[...items]
          .sort((a, b) => a.layer - b.layer)
          .map((it) => (
            <button
              key={it.id}
              type="button"
              data-testid={`island-item-${it.catalogId}`}
              data-item-id={it.id}
              aria-label={`${labelOf(it.catalogId)}${it.id === selfId ? `（${copy.me}）` : ''}`}
              aria-pressed={selected === it.id}
              className={`absolute flex h-14 w-14 items-center justify-center rounded-full transition-shadow ${
                selected === it.id ? 'ring-4 ring-calm' : ''
              } ${it.id === selfId ? 'bg-white/80 shadow-lift' : ''} focus-visible:outline-4 focus-visible:outline-calm-deep`}
              style={{
                left: `${it.x * 100}%`,
                top: `${it.y * 100}%`,
                transform: `translate(-50%,-50%) rotate(${it.rotation}deg)`,
                zIndex: it.layer,
              }}
              onKeyDown={(e) => onItemKey(e, it)}
              onFocus={() => setSelected(it.id)}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setSelected(it.id);
                const rect = stageRef.current!.getBoundingClientRect();
                drag.current = {
                  id: it.id,
                  dx: (e.clientX - rect.left) / rect.width - it.x,
                  dy: (e.clientY - rect.top) / rect.height - it.y,
                };
              }}
            >
              <IslandSprite id={it.catalogId} size={48} />
              {it.id === selfId && (
                <span aria-hidden="true" className="absolute -top-2 -right-2 text-base">
                  ⭐
                </span>
              )}
            </button>
          ))}
      </div>

      <div
        className="flex flex-wrap items-center gap-2"
        role="toolbar"
        aria-label={copy.selected}
        data-testid="island-toolbar"
      >
        {sel ? (
          <>
            <Button
              variant={selfId === sel.id ? 'primary' : 'calm'}
              size="md"
              data-testid="island-set-self"
              onClick={() => setSelfId(selfId === sel.id ? null : sel.id)}
              aria-pressed={selfId === sel.id}
            >
              ⭐ {selfId === sel.id ? copy.meOff : copy.me}
            </Button>
            <Button
              variant="secondary"
              size="md"
              data-testid="island-rotate"
              onClick={() => update(sel.id, { rotation: (sel.rotation + 45) % 360 })}
            >
              {copy.rotate}
            </Button>
            <Button
              variant="secondary"
              size="md"
              data-testid="island-layer-up"
              onClick={() => update(sel.id, { layer: sel.layer + 1 })}
            >
              {copy.up}
            </Button>
            <Button
              variant="secondary"
              size="md"
              data-testid="island-layer-down"
              onClick={() => update(sel.id, { layer: Math.max(0, sel.layer - 1) })}
            >
              {copy.down}
            </Button>
            <Button
              variant="ghost"
              size="md"
              data-testid="island-remove"
              onClick={() => remove(sel.id)}
            >
              {copy.remove}
            </Button>
          </>
        ) : (
          <p className="text-sm text-ink-soft">{copy.nothingSelected}</p>
        )}
      </div>
      <p className="text-xs text-ink-soft">{copy.meHint}</p>

      <div>
        <p className="mb-2 text-sm font-bold text-ink-soft" id="island-drawer-label">
          {copy.drawer}
        </p>
        <ul
          className="flex gap-2 overflow-x-auto pb-2"
          aria-labelledby="island-drawer-label"
          data-testid="island-drawer"
        >
          {catalog.map((c) => (
            <li key={c.catalogId} className="shrink-0">
              <button
                type="button"
                data-testid={`catalog-${c.catalogId}`}
                data-locked={c.locked}
                onClick={() => add(c)}
                disabled={c.locked || items.length >= MAX_ITEMS}
                aria-label={c.locked ? `${c.label}（${copy.locked}。${copy.lockedHint}）` : c.label}
                title={c.locked ? copy.lockedHint : undefined}
                className={`grade-tap tap-target flex flex-col items-center rounded-2xl bg-white px-3 py-2 text-sm shadow-soft hover:bg-cream-deep focus-visible:outline-4 focus-visible:outline-calm-deep disabled:cursor-not-allowed ${
                  c.locked ? 'opacity-50 grayscale' : ''
                }`}
              >
                <IslandSprite id={c.catalogId} size={40} />
                <span>{c.label}</span>
                {c.locked && (
                  <span aria-hidden="true" className="text-[0.65rem] text-ink-soft">
                    🔒 {copy.locked}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {catalog.some((c) => c.locked) && (
          <p className="text-xs text-ink-soft" data-testid="island-locked-hint">
            🔒 {copy.lockedHint}
          </p>
        )}
      </div>

      <Button
        size="xl"
        data-testid="island-done"
        disabled={busy}
        aria-busy={busy}
        onClick={() => onSave({ items, ...(selfId ? { selfFigureId: selfId } : {}) })}
      >
        {copy.save}
      </Button>
    </div>
  );
}
