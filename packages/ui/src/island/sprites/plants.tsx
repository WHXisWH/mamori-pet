import type { ReactElement } from 'react';

import { ISLAND_COLORS as C } from '../palette.js';

function Shadow({ rx = 24 }: { rx?: number }): ReactElement {
  return <ellipse cx="50" cy="94" rx={rx} ry="4" fill={C.ink} opacity="0.08" />;
}

function Trunk({
  x = 44,
  y = 60,
  w = 12,
  h = 34,
}: {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}) {
  return <rect x={x} y={y} width={w} height={h} rx={w / 2} fill={C.woodDeep} />;
}

export function Tree01(): ReactElement {
  return (
    <g>
      <Shadow />
      <Trunk />
      <circle cx="50" cy="44" r="28" fill={C.leaf} />
      <circle cx="32" cy="54" r="16" fill={C.leaf} />
      <circle cx="68" cy="54" r="16" fill={C.leaf} />
      <circle cx="44" cy="36" r="10" fill={C.leafSoft} opacity="0.7" />
    </g>
  );
}

export function Bush01(): ReactElement {
  return (
    <g>
      <Shadow rx={28} />
      <ellipse cx="50" cy="74" rx="32" ry="18" fill={C.leaf} />
      <circle cx="34" cy="64" r="14" fill={C.leaf} />
      <circle cx="54" cy="58" r="16" fill={C.leaf} />
      <circle cx="70" cy="68" r="12" fill={C.leaf} />
      <circle cx="48" cy="54" r="7" fill={C.leafSoft} opacity="0.7" />
      <circle cx="40" cy="74" r="2.5" fill={C.coral} />
      <circle cx="62" cy="78" r="2.5" fill={C.coral} />
    </g>
  );
}

function Flower({ petal, center }: { petal: string; center: string }): ReactElement {
  return (
    <g>
      <Shadow rx={14} />
      <path d="M50 92 v-30" stroke={C.leafDeep} strokeWidth="3" strokeLinecap="round" />
      <ellipse cx="42" cy="78" rx="8" ry="4" fill={C.leaf} transform="rotate(-30 42 78)" />
      <ellipse cx="58" cy="84" rx="8" ry="4" fill={C.leaf} transform="rotate(30 58 84)" />
      {[0, 72, 144, 216, 288].map((a) => (
        <ellipse
          key={a}
          cx="50"
          cy="38"
          rx="8"
          ry="13"
          fill={petal}
          transform={`rotate(${a} 50 50)`}
        />
      ))}
      <circle cx="50" cy="50" r="8" fill={center} />
    </g>
  );
}

export function Flower01(): ReactElement {
  return <Flower petal={C.coral} center={C.sun} />;
}

export function Flower02(): ReactElement {
  return <Flower petal={C.calm} center={C.cream} />;
}

export function Mushroom01(): ReactElement {
  return (
    <g>
      <Shadow rx={20} />
      <rect x="40" y="56" width="20" height="36" rx="9" fill={C.cream} />
      <path d="M18 58 q32 -46 64 0 z" fill={C.coral} />
      <g fill={C.cream}>
        <circle cx="38" cy="44" r="5" />
        <circle cx="58" cy="36" r="4" />
        <circle cx="66" cy="50" r="3" />
      </g>
    </g>
  );
}

export function CherryTree01(): ReactElement {
  return (
    <g>
      <Shadow />
      <Trunk />
      <circle cx="50" cy="44" r="28" fill={C.blush} />
      <circle cx="32" cy="54" r="16" fill={C.blush} />
      <circle cx="68" cy="54" r="16" fill={C.blush} />
      <circle cx="44" cy="36" r="10" fill={C.cream} opacity="0.6" />
      <g fill={C.blushDeep}>
        <circle cx="30" cy="40" r="2" />
        <circle cx="62" cy="30" r="2" />
        <circle cx="74" cy="64" r="2" />
        <circle cx="80" cy="84" r="1.6" />
      </g>
    </g>
  );
}

export function Tulip01(): ReactElement {
  return (
    <g>
      <Shadow rx={14} />
      <path d="M50 92 v-34" stroke={C.leafDeep} strokeWidth="3" strokeLinecap="round" />
      <path d="M50 88 q-18 -6 -16 -28 q10 6 16 20 z" fill={C.leaf} />
      <path d="M50 84 q18 -6 14 -26 q-10 6 -14 18 z" fill={C.leaf} />
      <path d="M36 56 q0 -22 14 -28 q14 6 14 28 q-14 6 -28 0 z" fill={C.coral} />
      <path d="M50 28 l-8 16 h16 z" fill={C.coral} />
      <path
        d="M44 40 q6 -6 12 0"
        stroke={C.blush}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

export function Sunflower01(): ReactElement {
  return (
    <g>
      <Shadow rx={16} />
      <path d="M50 92 v-36" stroke={C.leafDeep} strokeWidth="3.5" strokeLinecap="round" />
      <ellipse cx="38" cy="76" rx="10" ry="5" fill={C.leaf} transform="rotate(-30 38 76)" />
      <ellipse cx="62" cy="68" rx="10" ry="5" fill={C.leaf} transform="rotate(30 62 68)" />
      {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((a) => (
        <ellipse
          key={a}
          cx="50"
          cy="20"
          rx="5"
          ry="11"
          fill={C.sun}
          transform={`rotate(${a} 50 40)`}
        />
      ))}
      <circle cx="50" cy="40" r="11" fill={C.woodDeep} />
      <circle cx="47" cy="37" r="3" fill={C.wood} opacity="0.6" />
    </g>
  );
}

export function MapleTree01(): ReactElement {
  return (
    <g>
      <Shadow />
      <Trunk />
      <circle cx="50" cy="44" r="28" fill={C.orange} />
      <circle cx="32" cy="54" r="16" fill={C.coral} />
      <circle cx="68" cy="54" r="16" fill={C.orange} />
      <circle cx="46" cy="36" r="10" fill={C.sun} opacity="0.6" />
      <g fill={C.coral}>
        <circle cx="22" cy="86" r="2.5" />
        <circle cx="78" cy="88" r="2.5" />
      </g>
    </g>
  );
}

export function PineTree01(): ReactElement {
  return (
    <g>
      <Shadow rx={22} />
      <Trunk x={45} y={74} w={10} h={20} />
      <path d="M50 10 L72 44 H28 Z" fill={C.leafDeep} />
      <path d="M50 28 L78 62 H22 Z" fill={C.leafDeep} />
      <path d="M50 46 L84 80 H16 Z" fill={C.leafDeep} />
      <path d="M50 12 L60 28 H40 Z" fill={C.snow} opacity="0.7" />
      <path d="M38 50 h24" stroke={C.snow} strokeWidth="3" strokeLinecap="round" opacity="0.6" />
    </g>
  );
}
