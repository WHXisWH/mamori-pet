'use client';

import { MOOD_WEATHERS, type MoodWeather } from '@ijime/api-types';
import { WEATHER_LABELS, WeatherIcon } from '@ijime/ui';
import { Check } from 'lucide-react';

import { useChildStore } from '@/lib/store';

export function MoodWeatherPicker({
  onPick,
  selected,
  disabled = false,
}: {
  onPick: (w: MoodWeather) => void;
  selected?: MoodWeather | undefined;
  disabled?: boolean;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  return (
    <div className="grid grid-cols-2 gap-4" role="radiogroup" aria-label="心の天気">
      {MOOD_WEATHERS.map((w) => {
        const on = selected === w;
        return (
          <button
            key={w}
            type="button"
            role="radio"
            data-testid={`mood-${w}`}
            aria-checked={on}
            disabled={disabled}
            onClick={() => onPick(w)}
            className={`relative flex min-h-28 flex-col items-center justify-center gap-2 rounded-card border-4 p-4 text-lg font-bold transition focus-visible:outline-4 focus-visible:outline-calm-deep disabled:cursor-default ${
              on
                ? 'scale-[1.03] border-calm bg-white shadow-lift'
                : 'border-transparent bg-white shadow-soft hover:-translate-y-0.5 hover:shadow-lift'
            }`}
          >
            {on && (
              <span
                aria-hidden
                className="absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-calm text-white"
              >
                <Check size={20} strokeWidth={3} />
              </span>
            )}
            <WeatherIcon weather={w} size={56} />
            <span>{WEATHER_LABELS[w][gradeBand]}</span>
          </button>
        );
      })}
    </div>
  );
}
