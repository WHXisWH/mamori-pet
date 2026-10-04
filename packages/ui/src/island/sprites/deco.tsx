import type { ReactElement } from 'react';

import { ISLAND_COLORS as C } from '../palette.js';

function Shadow({ rx = 26 }: { rx?: number }): ReactElement {
  return <ellipse cx="50" cy="94" rx={rx} ry="4" fill={C.ink} opacity="0.08" />;
}

export function Boat01(): ReactElement {
  return (
    <g>
      <ellipse cx="50" cy="88" rx="36" ry="5" fill={C.calm} opacity="0.25" />
      <path d="M14 66 H86 L74 86 H26 Z" fill={C.woodDeep} />
      <path d="M18 66 H82 L78 72 H22 Z" fill={C.wood} />
      <rect x="48" y="18" width="4" height="48" rx="2" fill={C.woodDeep} />
      <path d="M52 22 L80 60 H52 Z" fill={C.cream} />
      <path d="M46 30 L28 60 H46 Z" fill={C.coral} />
    </g>
  );
}

export function Flag01(): ReactElement {
  return (
    <g>
      <Shadow rx={12} />
      <rect x="30" y="12" width="4" height="80" rx="2" fill={C.woodDeep} />
      <path d="M34 16 L78 28 L34 44 Z" fill={C.coral} />
      <path d="M34 22 L62 28 L34 36 Z" fill={C.cream} opacity="0.5" />
      <circle cx="32" cy="12" r="3.5" fill={C.sun} />
    </g>
  );
}

export function Kite01(): ReactElement {
  return (
    <g>
      <path d="M50 20 L74 46 L50 72 L26 46 Z" fill={C.coral} />
      <path d="M50 20 L74 46 L50 46 Z" fill={C.sun} />
      <path d="M50 46 L50 72 L26 46 Z" fill={C.calm} />
      <path d="M50 20 V72 M26 46 H74" stroke={C.cream} strokeWidth="1.5" />
      <path
        d="M50 72 q-6 10 2 16 q-8 4 -2 8"
        stroke={C.inkSoft}
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
      <g fill={C.blush}>
        <path d="M44 80 l4 -4 l-4 -4 l-4 4 z" />
        <path d="M54 90 l4 -4 l-4 -4 l-4 4 z" />
      </g>
    </g>
  );
}

export function Balloon01(): ReactElement {
  return (
    <g>
      <ellipse cx="50" cy="38" rx="22" ry="26" fill={C.coral} />
      <ellipse cx="42" cy="28" rx="6" ry="9" fill={C.cream} opacity="0.5" />
      <path d="M46 64 L54 64 L50 70 Z" fill={C.coral} />
      <path
        d="M50 70 q-6 10 2 14 q-6 4 0 8"
        stroke={C.inkSoft}
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

export function Frame01(): ReactElement {
  return (
    <g>
      <rect x="18" y="20" width="64" height="60" rx="4" fill={C.wood} />
      <rect x="26" y="28" width="48" height="44" rx="2" fill={C.cream} />
      <circle cx="40" cy="42" r="6" fill={C.sun} />
      <path d="M26 72 L44 54 L56 66 L64 58 L74 72 Z" fill={C.leaf} />
      <path d="M50 80 v8 M40 92 h20" stroke={C.woodDeep} strokeWidth="3" strokeLinecap="round" />
    </g>
  );
}

export function Windchime01(): ReactElement {
  return (
    <g>
      <path d="M50 8 v14" stroke={C.inkSoft} strokeWidth="1.5" />
      <path
        d="M30 40 q0 -22 20 -22 q20 0 20 22 z"
        fill={C.calmSoft}
        stroke={C.calm}
        strokeWidth="1.5"
      />
      <path d="M38 34 q12 -4 24 0" stroke={C.calm} strokeWidth="1.5" fill="none" />
      <path d="M50 40 v22" stroke={C.inkSoft} strokeWidth="1.2" />
      <circle cx="50" cy="44" r="3" fill={C.coral} />
      <rect
        x="40"
        y="60"
        width="20"
        height="30"
        rx="2"
        fill={C.cream}
        stroke={C.calmSoft}
        strokeWidth="1.5"
      />
      <path
        d="M46 68 q4 6 8 0 M46 80 q4 6 8 0"
        stroke={C.calm}
        strokeWidth="1.5"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

export function Watermelon01(): ReactElement {
  return (
    <g>
      <Shadow rx={30} />
      <path d="M14 56 a36 36 0 0 0 72 0 z" fill={C.leafDeep} />
      <path d="M20 56 a30 30 0 0 0 60 0 z" fill={C.cream} />
      <path d="M24 56 a26 26 0 0 0 52 0 z" fill={C.coral} />
      <g fill={C.ink}>
        <ellipse cx="40" cy="64" rx="1.6" ry="2.6" />
        <ellipse cx="52" cy="70" rx="1.6" ry="2.6" />
        <ellipse cx="62" cy="62" rx="1.6" ry="2.6" />
      </g>
    </g>
  );
}

export function SportsFlag01(): ReactElement {
  return (
    <g>
      <Shadow rx={36} />
      <path d="M10 30 q40 24 80 0" stroke={C.inkSoft} strokeWidth="1.5" fill="none" />
      {[16, 30, 44, 58, 72].map((x, i) => (
        <path
          key={x}
          d={`M${x} ${30 + Math.sin((i / 4) * Math.PI) * 10} l6 16 l6 -16 z`}
          fill={i % 2 === 0 ? C.coral : C.cream}
          stroke={i % 2 === 0 ? 'none' : C.sandDeep}
          strokeWidth="1"
        />
      ))}
      <rect x="46" y="54" width="8" height="38" rx="4" fill={C.woodDeep} />
      <circle cx="50" cy="56" r="10" fill={C.sun} />
      <path d="M44 56 h12" stroke={C.cream} strokeWidth="2" strokeLinecap="round" />
    </g>
  );
}

export function Bunting01(): ReactElement {
  return (
    <g>
      <path d="M6 24 q44 30 88 0" stroke={C.inkSoft} strokeWidth="1.5" fill="none" />
      {[
        [12, 27, C.coral],
        [26, 36, C.sun],
        [40, 41, C.calm],
        [54, 41, C.leaf],
        [68, 36, C.lilac],
        [82, 27, C.coral],
      ].map(([x, y, color]) => (
        <path key={String(x)} d={`M${x} ${y} h12 l-6 16 z`} fill={String(color)} />
      ))}
      <rect
        x="20"
        y="60"
        width="60"
        height="26"
        rx="4"
        fill={C.cream}
        stroke={C.sandDeep}
        strokeWidth="1.5"
      />
      <path d="M30 70 h40 M30 78 h26" stroke={C.inkSoft} strokeWidth="2" strokeLinecap="round" />
      <ellipse cx="50" cy="92" rx="32" ry="3" fill={C.ink} opacity="0.08" />
    </g>
  );
}

export function Snowman01(): ReactElement {
  return (
    <g>
      <Shadow rx={30} />
      <circle cx="50" cy="68" r="26" fill={C.snow} stroke={C.calmSoft} strokeWidth="1.5" />
      <circle cx="50" cy="34" r="18" fill={C.snow} stroke={C.calmSoft} strokeWidth="1.5" />
      <rect x="38" y="10" width="24" height="10" rx="2" fill={C.coral} />
      <rect x="42" y="4" width="16" height="8" rx="2" fill={C.coral} />
      <circle cx="44" cy="32" r="2" fill={C.ink} />
      <circle cx="56" cy="32" r="2" fill={C.ink} />
      <path d="M50 36 l8 2 l-8 2 z" fill={C.orange} />
      <path
        d="M44 40 q6 4 12 0"
        stroke={C.ink}
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M34 50 q16 6 32 0 v6 q-16 6 -32 0 z" fill={C.calm} />
      <g fill={C.ink}>
        <circle cx="50" cy="62" r="2" />
        <circle cx="50" cy="72" r="2" />
      </g>
    </g>
  );
}

export function Notebook01(): ReactElement {
  return (
    <g>
      <Shadow rx={26} />
      <rect x="24" y="14" width="52" height="72" rx="4" fill={C.calm} />
      <rect x="30" y="14" width="46" height="72" rx="3" fill={C.calmSoft} />
      <rect x="40" y="30" width="26" height="22" rx="2" fill={C.cream} />
      <path d="M44 38 h18 M44 44 h12" stroke={C.inkSoft} strokeWidth="1.5" strokeLinecap="round" />
      <g stroke={C.inkSoft} strokeWidth="2" strokeLinecap="round">
        <path d="M27 24 h-5 M27 36 h-5 M27 48 h-5 M27 60 h-5 M27 72 h-5" />
      </g>
      <circle cx="68" cy="22" r="3" fill={C.sun} />
    </g>
  );
}

export function Rock01(): ReactElement {
  return (
    <g>
      <Shadow rx={30} />
      <path d="M18 84 q-4 -30 22 -40 q24 -10 40 10 q8 14 2 30 z" fill={C.stone} />
      <path
        d="M30 60 q14 -16 36 -6"
        stroke={C.cream}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        opacity="0.6"
      />
      <ellipse cx="60" cy="74" rx="8" ry="5" fill={C.stoneDeep} opacity="0.3" />
      <circle cx="26" cy="86" r="4" fill={C.leaf} />
      <circle cx="78" cy="88" r="3" fill={C.leaf} />
    </g>
  );
}

export function Pond01(): ReactElement {
  return (
    <g>
      <ellipse cx="50" cy="60" rx="42" ry="24" fill={C.sandDeep} />
      <ellipse cx="50" cy="60" rx="36" ry="19" fill={C.calm} />
      <ellipse cx="50" cy="60" rx="30" ry="14" fill={C.calmSoft} opacity="0.4" />
      <path
        d="M30 56 q8 -4 16 0 M54 66 q8 -4 16 0"
        stroke={C.cream}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        opacity="0.8"
      />
      <ellipse cx="68" cy="54" rx="6" ry="4" fill={C.leaf} />
      <circle cx="70" cy="52" r="2" fill={C.blush} />
      <path
        d="M18 50 q2 -14 4 0"
        stroke={C.leafDeep}
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

export function Hill01(): ReactElement {
  return (
    <g>
      <path d="M4 92 q46 -70 92 0 z" fill={C.leaf} />
      <path d="M20 92 q30 -44 60 0 z" fill={C.leafSoft} opacity="0.5" />
      <g fill={C.cream}>
        <circle cx="36" cy="70" r="2" />
        <circle cx="60" cy="60" r="2" />
        <circle cx="72" cy="78" r="2" />
      </g>
      <circle cx="48" cy="80" r="2" fill={C.sun} />
    </g>
  );
}

export function Cloud01(): ReactElement {
  return (
    <g>
      <ellipse cx="50" cy="56" rx="34" ry="18" fill={C.cream} />
      <circle cx="36" cy="48" r="16" fill={C.cream} />
      <circle cx="58" cy="40" r="20" fill={C.cream} />
      <ellipse cx="50" cy="62" rx="30" ry="10" fill={C.calmSoft} opacity="0.5" />
      <circle cx="44" cy="50" r="1.8" fill={C.ink} />
      <circle cx="58" cy="50" r="1.8" fill={C.ink} />
      <path
        d="M48 56 q3 3 6 0"
        stroke={C.ink}
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

export function Rainbow01(): ReactElement {
  return (
    <g fill="none" strokeLinecap="round">
      <path d="M12 84 a38 38 0 0 1 76 0" stroke={C.coral} strokeWidth="8" />
      <path d="M20 84 a30 30 0 0 1 60 0" stroke={C.sun} strokeWidth="8" />
      <path d="M28 84 a22 22 0 0 1 44 0" stroke={C.leaf} strokeWidth="8" />
      <path d="M36 84 a14 14 0 0 1 28 0" stroke={C.calm} strokeWidth="8" />
      <g fill={C.cream} stroke="none">
        <ellipse cx="18" cy="84" rx="12" ry="7" />
        <ellipse cx="82" cy="84" rx="12" ry="7" />
      </g>
    </g>
  );
}

export function Star01(): ReactElement {
  return (
    <g>
      <Shadow rx={14} />
      <rect x="47" y="56" width="6" height="36" rx="3" fill={C.inkSoft} />
      <circle cx="50" cy="40" r="22" fill={C.star} opacity="0.25" />
      <path
        d="M50 20 l6 14 l15 2 l-11 10 l3 15 l-13 -8 l-13 8 l3 -15 l-11 -10 l15 -2 z"
        fill={C.star}
      />
      <path d="M50 20 l6 14 l15 2 l-11 10 l3 15 l-13 -8 z" fill={C.sun} opacity="0.5" />
    </g>
  );
}
