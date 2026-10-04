'use client';

import type {
  CharacterId,
  ChildHomeRes,
  DailyRituals,
  Expression,
  IslandSummary,
  MoodWeather,
} from '@ijime/api-types';
import { PetAvatar, SpeechBubble, WEATHER_LABELS, WeatherIcon } from '@ijime/ui';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

import { DecorationsDialog, type Decoration } from './DecorationsDialog';
import { GoodThingJar } from './GoodThingJar';
import { IslandGround, IslandSky, IslandSprite, type TimeOfDay } from './sprites';
import { WaterCan } from './WaterCan';

export type IslandSceneProps = {
  island: IslandSummary | undefined;
  todayMood: MoodWeather | undefined;
  timeOfDay: TimeOfDay;
  bedtime: boolean;
  pet: { characterId: CharacterId; expression: Expression; petName?: string };
  greeting: ChildHomeRes['greeting'];
  decorations: Decoration[];
  rituals: DailyRituals | undefined;
  goodThingCount: number;
  ritualBusy: boolean;
  onWater: () => void;
  onGoodThing: () => void;
  children?: ReactNode;
};

export function GreetingBubble({
  greeting,
}: {
  greeting: ChildHomeRes['greeting'] | { text: string; source?: 'agent' | 'template' };
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const fromAgent = greeting.source === 'agent';
  return (
    <div
      className="animate-fade-up"
      data-testid="greeting-bubble"
      data-source={greeting.source ?? 'template'}
    >
      <SpeechBubble
        tail="bottom"
        className={`max-w-[80vw] text-center sm:max-w-sm ${
          fromAgent ? 'border-2 border-sun bg-[#fffaf0]' : ''
        }`}
      >
        {fromAgent && (
          <span className="mb-1 block text-xs font-bold text-ink-soft">
            <span aria-hidden="true">✨ </span>
            {COPY[gradeBand].home.fromPet}
          </span>
        )}
        {greeting.text}
      </SpeechBubble>
    </div>
  );
}

const hotspot =
  'absolute flex items-center justify-center rounded-full focus-visible:outline-4 focus-visible:outline-calm-deep';

export function IslandScene({
  island,
  todayMood,
  timeOfDay,
  bedtime,
  pet,
  greeting,
  decorations,
  rituals,
  goodThingCount,
  ritualBusy,
  onWater,
  onGoodThing,
  children,
}: IslandSceneProps) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].home;
  const [showDecorations, setShowDecorations] = useState(false);
  const stage = island?.stage ?? 1;
  const season = island?.season ?? 'spring';
  const skyLabel = todayMood
    ? copy.skyToday.replace('{w}', WEATHER_LABELS[todayMood][gradeBand])
    : copy.sky;
  const night = timeOfDay === 'night' && !todayMood;

  return (
    <section
      aria-label={copy.scene}
      className="relative mx-auto w-full max-w-3xl overflow-hidden rounded-b-[2.5rem] sm:rounded-card"
      data-testid="pet-room"
      data-stage={stage}
      data-season={season}
      data-time={timeOfDay}
    >
      <div className="relative aspect-[4/5] w-full sm:aspect-[4/3]">
        <IslandSky weather={todayMood ?? timeOfDay} className="absolute inset-0 h-full w-full" />

        <Link
          href="/mood"
          data-testid="tile-mood"
          aria-label={skyLabel}
          className={`${hotspot} grade-tap tap-target top-3 left-3 bg-white/80 shadow-soft backdrop-blur hover:bg-white`}
        >
          {todayMood ? (
            <WeatherIcon weather={todayMood} size={40} />
          ) : (
            <span aria-hidden="true" className="text-2xl">
              {night ? '🌙' : '⛅'}
            </span>
          )}
        </Link>

        {island && (
          <p
            className="absolute top-3 right-3 rounded-full bg-white/80 px-3 py-1 text-xs font-bold text-ink-soft shadow-soft"
            data-testid="island-visit-days"
          >
            {copy.visitDays.replace('{n}', String(island.visitDays))}
          </p>
        )}

        <div className="absolute inset-x-0 bottom-0 aspect-[4/3] w-full">
          <IslandGround stage={stage} season={season} className="absolute inset-0 h-full w-full" />

          <div className="absolute inset-x-0 bottom-[36%] flex flex-col items-center gap-2 px-4">
            <GreetingBubble greeting={greeting} />
            <Link
              href="/chat"
              data-testid="tile-chat"
              aria-label={`${pet.petName ? `${pet.petName}。` : ''}${copy.pet}`}
              className="animate-pop rounded-full focus-visible:outline-4 focus-visible:outline-calm-deep"
            >
              <PetAvatar
                characterId={pet.characterId}
                expression={pet.expression}
                size="clamp(110px, 30vw, 180px)"
              />
            </Link>
          </div>

          <WaterCan
            doneToday={rituals?.watered ?? false}
            busy={ritualBusy}
            onWater={onWater}
            className="absolute bottom-[24%] left-[12%]"
          />

          <button
            type="button"
            data-testid="island-house"
            data-decorations={decorations.length}
            aria-label={copy.house}
            onClick={() => setShowDecorations(true)}
            className={`${hotspot} grade-tap tap-target right-[12%] bottom-[28%] flex-col p-1 transition hover:-translate-y-0.5`}
          >
            <IslandSprite id="house" size="clamp(56px, 16vw, 88px)" />
            {decorations.length > 0 && (
              <span
                aria-hidden="true"
                className="absolute top-[42%] left-1/2 flex -translate-x-1/2 gap-0.5 rounded-sm bg-white/90 p-0.5"
              >
                {decorations.slice(0, 3).map((d) => (
                  <img
                    key={d.artworkId}
                    src={d.thumbnailUrl}
                    alt=""
                    className="h-4 w-4 rounded-[2px] object-cover sm:h-5 sm:w-5"
                    data-testid="decoration-thumb"
                  />
                ))}
              </span>
            )}
          </button>

          {bedtime && (
            <GoodThingJar
              count={goodThingCount}
              doneToday={rituals?.goodThing ?? false}
              busy={ritualBusy}
              onAdd={onGoodThing}
              className="absolute bottom-[18%] left-[30%]"
            />
          )}
        </div>

        <Link
          href="/island"
          data-testid="island-arrange"
          className="grade-tap tap-target absolute right-3 bottom-3 inline-flex items-center gap-2 rounded-full bg-white/90 px-4 font-bold text-ink shadow-soft backdrop-blur hover:bg-white focus-visible:outline-4 focus-visible:outline-calm-deep"
        >
          <span aria-hidden="true">🪴</span>
          {copy.arrange}
        </Link>
      </div>
      {children}
      {showDecorations && (
        <DecorationsDialog decorations={decorations} onClose={() => setShowDecorations(false)} />
      )}
    </section>
  );
}
