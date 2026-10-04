'use client';

import type { CharacterId, Expression } from '@ijime/api-types';
import { CHARACTER_META, PetAvatar, SELECTABLE_CHARACTERS } from '@ijime/ui';
import { useState, type PointerEvent } from 'react';

import { Reveal } from './Reveal';
import { Kicker } from './Sections';

function tilt(e: PointerEvent<HTMLDivElement>) {
  if (e.pointerType !== 'mouse') return;
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  el.style.setProperty('--ry', `${((px - 0.5) * 12).toFixed(2)}deg`);
  el.style.setProperty('--rx', `${((0.5 - py) * 9).toFixed(2)}deg`);
  el.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
  el.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
}

function untilt(e: PointerEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  el.style.setProperty('--ry', '0deg');
  el.style.setProperty('--rx', '0deg');
}

function CharacterCard({ id, index }: { id: CharacterId; index: number }) {
  const meta = CHARACTER_META[id];
  const [expression, setExpression] = useState<Expression>('happy');
  return (
    <Reveal as="li" delayMs={index * 80}>
      <div className="tilt h-full" onPointerMove={tilt} onPointerLeave={untilt}>
        <button
          type="button"
          onMouseEnter={() => setExpression('celebrate')}
          onMouseLeave={() => setExpression('happy')}
          onFocus={() => setExpression('celebrate')}
          onBlur={() => setExpression('happy')}
          onClick={() => setExpression((e) => (e === 'celebrate' ? 'together' : 'celebrate'))}
          className="group relative flex h-full w-full flex-col items-center overflow-hidden rounded-card bg-white p-6 text-center shadow-soft transition-shadow duration-500 hover:shadow-lift focus-visible:outline-4 focus-visible:outline-calm-deep"
          aria-label={`${meta.displayName}（${meta.archetype}）`}
        >
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-40 opacity-60"
            style={{
              background: `radial-gradient(70% 90% at 50% 0%, ${meta.main}, transparent 70%)`,
            }}
          />
          <span
            aria-hidden="true"
            className="glare pointer-events-none absolute inset-0 z-10 mix-blend-soft-light"
          />
          <div
            className="relative rounded-full p-4 shadow-[inset_0_-10px_24px_rgba(0,0,0,0.06)] transition duration-500 group-hover:scale-105"
            style={{ background: meta.main, transform: 'translateZ(30px)' }}
          >
            <PetAvatar characterId={id} expression={expression} size={150} />
          </div>
          <h3 className="mt-4 font-display text-2xl font-bold">{meta.displayName}</h3>
          <p className="text-sm text-ink-soft">{meta.archetype}</p>
          <p className="mt-3 font-display text-base text-calm-deep">「{meta.tagline}」</p>
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">{meta.personality}</p>
          <p className="mt-3 rounded-full bg-cream px-3 py-1 text-xs font-bold text-ink-soft">
            {meta.goodFor}
          </p>
        </button>
      </div>
    </Reveal>
  );
}

export function Characters() {
  return (
    <section
      id="characters"
      className="relative bg-cream-deep/50 pb-24"
      aria-labelledby="characters-title"
    >
      <div
        aria-hidden="true"
        className="h-[22vh] bg-[linear-gradient(to_bottom,var(--color-night),transparent)]"
      />
      <div className="mx-auto max-w-6xl px-4 md:px-8">
        <Reveal>
          <Kicker>CHARACTERS</Kicker>
          <h2
            id="characters-title"
            className="phrase mt-4 font-display text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.3] font-bold"
          >
            なかまは、5ひき と たまご。
          </h2>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-soft">
            性格も話し方もそれぞれ。でも、みんな同じ約束を守ります。なかまは、いつでも替えられます。
          </p>
        </Reveal>
        <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {SELECTABLE_CHARACTERS.map((id, i) => (
            <CharacterCard key={id} id={id} index={i} />
          ))}
          <Reveal as="li" delayMs={5 * 80}>
            <div className="flex h-full flex-col items-center justify-center rounded-card border-2 border-dashed border-hidden-deep bg-white/60 p-6 text-center">
              <PetAvatar characterId="hidden" expression="happy" size={150} />
              <h3 className="mt-4 font-display text-2xl font-bold">？</h3>
              <p className="text-sm text-ink-soft">{CHARACTER_META.hidden.archetype}</p>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                {CHARACTER_META.hidden.personality}
                <br />
                課金もレア度もありません。
              </p>
            </div>
          </Reveal>
        </ul>
      </div>
    </section>
  );
}
