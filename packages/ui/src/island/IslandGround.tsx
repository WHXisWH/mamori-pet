import type { CSSProperties, ReactElement } from 'react';

import { ISLAND_COLORS as C, type IslandSeason, type IslandStage } from './palette.js';

export type IslandGroundProps = {
  stage: IslandStage;
  season: IslandSeason;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: CSSProperties;
};

type GroundPalette = { grass: string; grassDeep: string; sand: string; accent: string };

const SEASON_PALETTE: Record<IslandSeason, GroundPalette> = {
  spring: { grass: C.leafSoft, grassDeep: C.leaf, sand: C.sand, accent: C.blush },
  summer: { grass: C.leaf, grassDeep: C.leafDeep, sand: C.sand, accent: C.sun },
  autumn: { grass: '#c8b36a', grassDeep: '#a08c48', sand: C.sandDeep, accent: C.orange },
  winter: { grass: C.snow, grassDeep: C.calmSoft, sand: C.creamDeep, accent: C.calmSoft },
};

export function IslandGround({
  stage,
  season,
  width = '100%',
  height,
  className,
  style,
}: IslandGroundProps): ReactElement {
  const p = SEASON_PALETTE[season];
  return (
    <svg
      viewBox="0 0 400 240"
      width={width}
      height={height}
      aria-hidden="true"
      className={className}
      style={style}
      data-stage={stage}
      data-season={season}
    >
      <ellipse cx="200" cy="200" rx="200" ry="44" fill={C.calm} opacity="0.35" />
      <ellipse cx="200" cy="196" rx="180" ry="36" fill={C.calmSoft} opacity="0.5" />
      <ellipse cx="200" cy="178" rx="160" ry="56" fill={p.sand} />
      <ellipse cx="200" cy="174" rx="150" ry="48" fill={C.cream} opacity="0.35" />
      {stage >= 2 && (
        <g>
          <ellipse cx="190" cy="166" rx="112" ry="34" fill={p.grass} />
          <ellipse cx="190" cy="164" rx="100" ry="28" fill={p.grassDeep} opacity="0.25" />
          <path
            d="M200 200 q-10 -24 10 -48"
            stroke={p.sand}
            strokeWidth="12"
            fill="none"
            strokeLinecap="round"
            opacity="0.9"
          />
        </g>
      )}
      {stage >= 3 && (
        <g>
          <ellipse cx="120" cy="150" rx="40" ry="14" fill={p.grassDeep} opacity="0.3" />
          <ellipse cx="270" cy="150" rx="46" ry="16" fill={p.grassDeep} opacity="0.3" />
          <Hut x={110} y={104} />
          <Fence x={236} y={140} />
          <g fill={p.accent}>
            <circle cx="160" cy="184" r="3" />
            <circle cx="176" cy="190" r="2.5" />
            <circle cx="248" cy="186" r="3" />
            <circle cx="92" cy="170" r="2.5" />
          </g>
        </g>
      )}
      {season === 'winter' && (
        <g fill={C.snow} opacity="0.8">
          <circle cx="80" cy="120" r="2" />
          <circle cx="150" cy="96" r="2.4" />
          <circle cx="300" cy="110" r="2" />
          <circle cx="340" cy="150" r="1.8" />
        </g>
      )}
      {season === 'spring' && stage >= 2 && (
        <g fill={C.blush} opacity="0.8">
          <ellipse cx="140" cy="140" rx="3" ry="2" />
          <ellipse cx="236" cy="144" rx="3" ry="2" />
          <ellipse cx="206" cy="132" rx="3" ry="2" />
        </g>
      )}
    </svg>
  );
}

function Hut({ x, y }: { x: number; y: number }): ReactElement {
  return (
    <g transform={`translate(${x} ${y})`}>
      <rect x="0" y="22" width="44" height="30" rx="3" fill={C.cream} />
      <path d="M-6 24 L22 0 L50 24 Z" fill={C.coral} />
      <rect x="16" y="34" width="12" height="18" rx="4" fill={C.woodDeep} />
      <rect x="4" y="30" width="8" height="8" rx="1.5" fill={C.calmSoft} />
      <rect x="32" y="30" width="8" height="8" rx="1.5" fill={C.calmSoft} />
    </g>
  );
}

function Fence({ x, y }: { x: number; y: number }): ReactElement {
  return (
    <g transform={`translate(${x} ${y})`} stroke={C.wood} strokeWidth="3" strokeLinecap="round">
      <path d="M0 0 v22 M14 -2 v24 M28 -2 v24 M42 0 v22 M-4 8 h50 M-4 16 h50" />
    </g>
  );
}
