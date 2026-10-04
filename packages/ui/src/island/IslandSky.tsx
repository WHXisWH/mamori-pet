import type { MoodWeather } from '@ijime/api-types';
import type { CSSProperties, ReactElement } from 'react';

import { ISLAND_COLORS as C } from './palette.js';

export const ISLAND_TIMES_OF_DAY = ['morning', 'day', 'evening', 'night'] as const;
export type TimeOfDay = (typeof ISLAND_TIMES_OF_DAY)[number];
export type IslandSkyWeather = MoodWeather | TimeOfDay;

export type IslandSkyProps = {
  weather: IslandSkyWeather;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
};

type SkyPalette = { top: string; bottom: string; cloud: string };

const SKY: Record<IslandSkyWeather, SkyPalette> = {
  sunny: { top: '#bcd6ee', bottom: '#eef6fb', cloud: C.snow },
  cloudy: { top: '#c9d3dc', bottom: '#ebeff3', cloud: '#e4e9ee' },
  rainy: { top: '#9fb1c4', bottom: '#d3dce6', cloud: '#c9d3dc' },
  stormy: { top: '#7c8797', bottom: '#b7bfca', cloud: '#9aa4b2' },
  morning: { top: '#ffd9b8', bottom: '#fff4e6', cloud: C.snow },
  day: { top: '#a8d8f5', bottom: '#eaf6ff', cloud: C.snow },
  evening: { top: '#f6a96b', bottom: '#fbe9ec', cloud: '#fde2cf' },
  night: { top: '#1f2233', bottom: '#2c3150', cloud: '#3a4060' },
};

export function IslandSky({
  weather,
  width = '100%',
  height,
  className,
  style,
}: IslandSkyProps): ReactElement {
  const sky = SKY[weather];
  const gradientId = `island-sky-${weather}`;
  return (
    <svg
      viewBox="0 0 400 200"
      width={width}
      height={height}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      className={className}
      style={style}
      data-sky={weather}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={sky.top} />
          <stop offset="1" stopColor={sky.bottom} />
        </linearGradient>
      </defs>
      <rect width="400" height="200" fill={`url(#${gradientId})`} />
      {weather === 'sunny' && (
        <g>
          <circle cx="320" cy="56" r="34" fill={C.sun} opacity="0.25" />
          <circle cx="320" cy="56" r="24" fill={C.sun} />
          <Cloud x={60} y={60} scale={0.8} color={sky.cloud} />
          <Cloud x={200} y={40} scale={0.55} color={sky.cloud} />
        </g>
      )}
      {weather === 'cloudy' && (
        <g>
          <Cloud x={50} y={50} scale={1} color={sky.cloud} />
          <Cloud x={190} y={80} scale={0.8} color={sky.cloud} />
          <Cloud x={290} y={40} scale={1.1} color={sky.cloud} />
        </g>
      )}
      {weather === 'rainy' && (
        <g>
          <Cloud x={70} y={40} scale={1.1} color={sky.cloud} />
          <Cloud x={240} y={30} scale={1.2} color={sky.cloud} />
          <g stroke={C.calm} strokeWidth="3" strokeLinecap="round" opacity="0.7">
            {[90, 120, 150, 260, 290, 320, 350].map((x, i) => (
              <line key={x} x1={x} y1={110 + (i % 2) * 14} x2={x - 4} y2={128 + (i % 2) * 14} />
            ))}
          </g>
        </g>
      )}
      {weather === 'stormy' && (
        <g>
          <Cloud x={60} y={36} scale={1.2} color={sky.cloud} />
          <Cloud x={230} y={28} scale={1.3} color={sky.cloud} />
          <path d="M150 104 l-16 30 h14 l-6 26 l22 -36 h-14 l8 -20 z" fill={C.sun} opacity="0.9" />
          <g stroke={C.calmDeep} strokeWidth="3" strokeLinecap="round" opacity="0.5">
            {[250, 280, 310].map((x) => (
              <line key={x} x1={x} y1="112" x2={x - 4} y2="130" />
            ))}
          </g>
        </g>
      )}
      {weather === 'morning' && (
        <g>
          <circle cx="320" cy="90" r="40" fill={C.sun} opacity="0.2" />
          <circle cx="320" cy="90" r="24" fill={C.sun} opacity="0.85" />
          <Cloud x={40} y={70} scale={0.7} color={sky.cloud} />
          <g fill={C.ink} opacity="0.5">
            <path d="M120 50 q6 -6 12 0 q6 -6 12 0" stroke={C.ink} strokeWidth="2" fill="none" />
            <path d="M160 36 q5 -5 10 0 q5 -5 10 0" stroke={C.ink} strokeWidth="2" fill="none" />
          </g>
        </g>
      )}
      {weather === 'day' && (
        <g>
          <circle cx="330" cy="50" r="30" fill={C.sun} opacity="0.25" />
          <circle cx="330" cy="50" r="22" fill={C.sun} />
          <Cloud x={70} y={44} scale={0.75} color={sky.cloud} />
          <Cloud x={210} y={70} scale={0.5} color={sky.cloud} />
        </g>
      )}
      {weather === 'evening' && (
        <g>
          <circle cx="330" cy="120" r="44" fill={C.sun} opacity="0.2" />
          <circle cx="330" cy="120" r="26" fill={C.sun} opacity="0.9" />
          <Cloud x={50} y={50} scale={0.9} color={sky.cloud} />
          <Cloud x={200} y={30} scale={0.6} color={sky.cloud} />
        </g>
      )}
      {weather === 'night' && (
        <g>
          <circle cx="320" cy="56" r="22" fill="#f1c76b" />
          <circle cx="312" cy="50" r="18" fill={sky.top} />
          <g fill="#f1c76b">
            <circle cx="60" cy="40" r="2" />
            <circle cx="140" cy="70" r="1.5" />
            <circle cx="240" cy="30" r="1.8" />
            <circle cx="100" cy="110" r="1.4" />
            <circle cx="200" cy="90" r="1.2" />
          </g>
          <Cloud x={40} y={120} scale={0.7} color={sky.cloud} />
        </g>
      )}
    </svg>
  );
}

function Cloud({
  x,
  y,
  scale,
  color,
}: {
  x: number;
  y: number;
  scale: number;
  color: string;
}): ReactElement {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} fill={color}>
      <ellipse cx="50" cy="36" rx="48" ry="20" />
      <circle cx="30" cy="24" r="22" />
      <circle cx="62" cy="16" r="26" />
    </g>
  );
}
