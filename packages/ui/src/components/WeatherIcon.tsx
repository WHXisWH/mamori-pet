import type { MoodWeather } from '@ijime/api-types';
import type { ReactElement } from 'react';

export const WEATHER_LABELS: Record<MoodWeather, { low: string; high: string; jhs: string }> = {
  sunny: { low: 'はれ', high: '晴れ', jhs: '晴れ' },
  cloudy: { low: 'くもり', high: 'くもり', jhs: '曇り' },
  rainy: { low: 'あめ', high: '雨', jhs: '雨' },
  stormy: { low: 'かみなり', high: '雷', jhs: '雷' },
};

export function WeatherIcon({
  weather,
  size = 64,
  className,
}: {
  weather: MoodWeather;
  size?: number | string;
  className?: string;
}): ReactElement {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" className={className}>
      {weather === 'sunny' && (
        <g>
          <circle cx="32" cy="32" r="13" fill="#f4c95d" />
          {Array.from({ length: 8 }, (_, i) => (
            <line
              key={i}
              x1="32"
              y1="8"
              x2="32"
              y2="14"
              stroke="#f4c95d"
              strokeWidth="4"
              strokeLinecap="round"
              transform={`rotate(${i * 45} 32 32)`}
            />
          ))}
        </g>
      )}
      {weather === 'cloudy' && <Cloud color="#c9d3dc" />}
      {weather === 'rainy' && (
        <g>
          <Cloud color="#9fb1c4" y={-6} />
          {[22, 32, 42].map((x, i) => (
            <line
              key={x}
              x1={x}
              y1="44"
              x2={x - 3}
              y2="54"
              stroke="#6b9ac4"
              strokeWidth="3.5"
              strokeLinecap="round"
              opacity={i === 1 ? 1 : 0.8}
            />
          ))}
        </g>
      )}
      {weather === 'stormy' && (
        <g>
          <Cloud color="#7c8797" y={-6} />
          <path d="M34 40 l-8 12 h7 l-3 10 l10 -14 h-7 l4 -8 z" fill="#f4c95d" />
        </g>
      )}
    </svg>
  );
}

function Cloud({ color, y = 0 }: { color: string; y?: number }) {
  return (
    <g transform={`translate(0 ${y})`}>
      <ellipse cx="32" cy="36" rx="20" ry="11" fill={color} />
      <circle cx="24" cy="30" r="10" fill={color} />
      <circle cx="38" cy="26" r="12" fill={color} />
    </g>
  );
}
