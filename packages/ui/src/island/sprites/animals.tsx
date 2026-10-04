import type { ReactElement } from 'react';

import { ISLAND_COLORS as C } from '../palette.js';

function Shadow(): ReactElement {
  return <ellipse cx="50" cy="94" rx="26" ry="4" fill={C.ink} opacity="0.08" />;
}

function Eyes({ y, dx = 9, r = 2.6 }: { y: number; dx?: number; r?: number }): ReactElement {
  return (
    <g fill={C.ink}>
      <circle cx={50 - dx} cy={y} r={r} />
      <circle cx={50 + dx} cy={y} r={r} />
    </g>
  );
}

function Cheeks({ y, dx = 15 }: { y: number; dx?: number }): ReactElement {
  return (
    <g fill={C.blush} opacity="0.7">
      <ellipse cx={50 - dx} cy={y} rx="4.5" ry="2.5" />
      <ellipse cx={50 + dx} cy={y} rx="4.5" ry="2.5" />
    </g>
  );
}

export function Rabbit01(): ReactElement {
  return (
    <g>
      <Shadow />
      <ellipse
        cx="38"
        cy="22"
        rx="6"
        ry="16"
        fill={C.cream}
        stroke={C.creamDeep}
        strokeWidth="1.5"
      />
      <ellipse
        cx="62"
        cy="22"
        rx="6"
        ry="16"
        fill={C.cream}
        stroke={C.creamDeep}
        strokeWidth="1.5"
      />
      <ellipse cx="38" cy="24" rx="3" ry="11" fill={C.blush} opacity="0.6" />
      <ellipse cx="62" cy="24" rx="3" ry="11" fill={C.blush} opacity="0.6" />
      <ellipse cx="50" cy="66" rx="26" ry="26" fill={C.cream} />
      <circle cx="50" cy="48" r="20" fill={C.cream} />
      <Eyes y={46} dx={8} />
      <Cheeks y={54} dx={13} />
      <path
        d="M47 54 q3 3 6 0"
        stroke={C.ink}
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
      <ellipse cx="38" cy="88" rx="7" ry="4" fill={C.creamDeep} />
      <ellipse cx="62" cy="88" rx="7" ry="4" fill={C.creamDeep} />
    </g>
  );
}

export function Bear01(): ReactElement {
  return (
    <g>
      <Shadow />
      <circle cx="30" cy="34" r="9" fill={C.woodDeep} />
      <circle cx="70" cy="34" r="9" fill={C.woodDeep} />
      <circle cx="30" cy="34" r="4.5" fill={C.wood} />
      <circle cx="70" cy="34" r="4.5" fill={C.wood} />
      <ellipse cx="50" cy="68" rx="28" ry="24" fill={C.woodDeep} />
      <circle cx="50" cy="46" r="22" fill={C.woodDeep} />
      <ellipse cx="50" cy="54" rx="10" ry="7" fill={C.wood} />
      <ellipse cx="50" cy="52" rx="3.5" ry="2.5" fill={C.ink} />
      <ellipse cx="50" cy="74" rx="14" ry="10" fill={C.wood} />
      <Eyes y={44} dx={9} />
      <ellipse cx="36" cy="90" rx="8" ry="4" fill={C.wood} />
      <ellipse cx="64" cy="90" rx="8" ry="4" fill={C.wood} />
    </g>
  );
}

export function Fox01(): ReactElement {
  return (
    <g>
      <Shadow />
      <path d="M70 72 q22 -8 18 -34 q-4 18 -22 24 z" fill={C.orange} />
      <path d="M84 48 q4 10 -4 16 q-1 -9 -6 -13 z" fill={C.cream} />
      <path d="M30 44 L26 16 L48 36 Z" fill={C.orange} />
      <path d="M70 44 L74 16 L52 36 Z" fill={C.orange} />
      <path d="M32 40 L30 24 L44 36 Z" fill={C.cream} />
      <path d="M68 40 L70 24 L56 36 Z" fill={C.cream} />
      <ellipse cx="50" cy="66" rx="26" ry="24" fill={C.orange} />
      <circle cx="50" cy="48" r="20" fill={C.orange} />
      <ellipse cx="50" cy="58" rx="14" ry="10" fill={C.cream} />
      <ellipse cx="50" cy="54" rx="3" ry="2.2" fill={C.ink} />
      <Eyes y={46} dx={9} />
      <ellipse cx="38" cy="89" rx="7" ry="4" fill={C.orangeDeep} />
      <ellipse cx="62" cy="89" rx="7" ry="4" fill={C.orangeDeep} />
    </g>
  );
}

export function Cat01(): ReactElement {
  return (
    <g>
      <Shadow />
      <path d="M30 44 L28 20 L46 34 Z" fill={C.stone} />
      <path d="M70 44 L72 20 L54 34 Z" fill={C.stone} />
      <path d="M32 40 L31 26 L42 35 Z" fill={C.blush} opacity="0.6" />
      <path d="M68 40 L69 26 L58 35 Z" fill={C.blush} opacity="0.6" />
      <path
        d="M74 76 q20 -4 16 -24"
        stroke={C.stone}
        strokeWidth="7"
        fill="none"
        strokeLinecap="round"
      />
      <ellipse cx="50" cy="68" rx="26" ry="22" fill={C.stone} />
      <circle cx="50" cy="48" r="21" fill={C.stone} />
      <ellipse cx="50" cy="74" rx="14" ry="10" fill={C.cream} />
      <Eyes y={46} dx={9} />
      <path
        d="M48 54 l2 2 l2 -2"
        stroke={C.ink}
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
      <g stroke={C.inkSoft} strokeWidth="1.2" strokeLinecap="round">
        <path d="M30 52 h-10 M30 56 h-10 M70 52 h10 M70 56 h10" />
      </g>
      <Cheeks y={54} />
    </g>
  );
}

export function Dog01(): ReactElement {
  return (
    <g>
      <Shadow />
      <ellipse cx="29" cy="48" rx="8" ry="16" fill={C.wood} transform="rotate(10 29 48)" />
      <ellipse cx="71" cy="48" rx="8" ry="16" fill={C.wood} transform="rotate(-10 71 48)" />
      <path
        d="M74 72 q14 -8 10 -24"
        stroke={C.sand}
        strokeWidth="7"
        fill="none"
        strokeLinecap="round"
      />
      <ellipse cx="50" cy="68" rx="26" ry="22" fill={C.sand} />
      <circle cx="50" cy="48" r="21" fill={C.sand} />
      <ellipse cx="50" cy="58" rx="12" ry="9" fill={C.cream} />
      <ellipse cx="50" cy="55" rx="3.5" ry="2.5" fill={C.ink} />
      <path
        d="M46 61 q4 4 8 0"
        stroke={C.ink}
        strokeWidth="1.6"
        fill="none"
        strokeLinecap="round"
      />
      <Eyes y={46} dx={9} />
      <ellipse cx="38" cy="89" rx="7" ry="4" fill={C.wood} />
      <ellipse cx="62" cy="89" rx="7" ry="4" fill={C.wood} />
    </g>
  );
}

export function Bird01(): ReactElement {
  return (
    <g>
      <ellipse cx="50" cy="90" rx="16" ry="3" fill={C.ink} opacity="0.08" />
      <ellipse cx="50" cy="62" rx="20" ry="18" fill={C.calm} />
      <circle cx="50" cy="46" r="15" fill={C.calm} />
      <ellipse cx="34" cy="64" rx="9" ry="14" fill={C.calmDeep} transform="rotate(20 34 64)" />
      <ellipse cx="66" cy="64" rx="9" ry="14" fill={C.calmDeep} transform="rotate(-20 66 64)" />
      <ellipse cx="50" cy="68" rx="11" ry="9" fill={C.calmSoft} />
      <path d="M50 50 l-6 3 l6 3 z" fill={C.sun} />
      <circle cx="44" cy="44" r="2.2" fill={C.ink} />
      <circle cx="56" cy="44" r="2.2" fill={C.ink} />
      <path
        d="M46 32 q4 -8 8 0"
        stroke={C.calmDeep}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M44 80 v8 M56 80 v8" stroke={C.sun} strokeWidth="2.5" strokeLinecap="round" />
    </g>
  );
}

export function Turtle01(): ReactElement {
  return (
    <g>
      <Shadow />
      <ellipse cx="50" cy="66" rx="30" ry="22" fill={C.leafDeep} />
      <ellipse cx="50" cy="62" rx="22" ry="15" fill={C.leaf} />
      <g fill={C.leafDeep} opacity="0.5">
        <circle cx="50" cy="58" r="6" />
        <circle cx="38" cy="66" r="4" />
        <circle cx="62" cy="66" r="4" />
      </g>
      <circle cx="80" cy="66" r="10" fill={C.leafSoft} />
      <circle cx="83" cy="63" r="1.8" fill={C.ink} />
      <path
        d="M80 70 q3 2 6 0"
        stroke={C.ink}
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
      <ellipse cx="30" cy="86" rx="8" ry="4" fill={C.leafSoft} />
      <ellipse cx="62" cy="86" rx="8" ry="4" fill={C.leafSoft} />
    </g>
  );
}

export function Owl01(): ReactElement {
  return (
    <g>
      <Shadow />
      <path d="M30 40 L28 24 L42 34 Z" fill={C.nightSoft} />
      <path d="M70 40 L72 24 L58 34 Z" fill={C.nightSoft} />
      <ellipse cx="50" cy="60" rx="26" ry="30" fill={C.nightSoft} />
      <ellipse cx="50" cy="70" rx="16" ry="14" fill={C.lilac} opacity="0.6" />
      <circle cx="40" cy="48" r="10" fill={C.star} />
      <circle cx="60" cy="48" r="10" fill={C.star} />
      <circle cx="40" cy="48" r="4" fill={C.ink} />
      <circle cx="60" cy="48" r="4" fill={C.ink} />
      <path d="M47 58 L53 58 L50 63 Z" fill={C.star} />
      <path
        d="M42 90 l3 -5 l3 5 M52 90 l3 -5 l3 5"
        stroke={C.star}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

export function Frog01(): ReactElement {
  return (
    <g>
      <Shadow />
      <ellipse cx="50" cy="70" rx="28" ry="20" fill={C.leaf} />
      <circle cx="36" cy="46" r="10" fill={C.leaf} />
      <circle cx="64" cy="46" r="10" fill={C.leaf} />
      <circle cx="36" cy="46" r="5" fill={C.cream} />
      <circle cx="64" cy="46" r="5" fill={C.cream} />
      <circle cx="36" cy="46" r="2.4" fill={C.ink} />
      <circle cx="64" cy="46" r="2.4" fill={C.ink} />
      <ellipse cx="50" cy="56" rx="20" ry="12" fill={C.leaf} />
      <path
        d="M40 60 q10 8 20 0"
        stroke={C.ink}
        strokeWidth="1.8"
        fill="none"
        strokeLinecap="round"
      />
      <Cheeks y={60} dx={16} />
      <ellipse cx="50" cy="78" rx="16" ry="9" fill={C.leafSoft} />
      <ellipse cx="28" cy="86" rx="9" ry="4" fill={C.leafDeep} />
      <ellipse cx="72" cy="86" rx="9" ry="4" fill={C.leafDeep} />
    </g>
  );
}

export function Deer01(): ReactElement {
  return (
    <g>
      <Shadow />
      <g stroke={C.woodDeep} strokeWidth="3" fill="none" strokeLinecap="round">
        <path d="M38 30 v-14 M38 22 l-8 -6 M38 18 l6 -6" />
        <path d="M62 30 v-14 M62 22 l8 -6 M62 18 l-6 -6" />
      </g>
      <ellipse cx="30" cy="42" rx="6" ry="9" fill={C.wood} transform="rotate(-20 30 42)" />
      <ellipse cx="70" cy="42" rx="6" ry="9" fill={C.wood} transform="rotate(20 70 42)" />
      <ellipse cx="50" cy="70" rx="24" ry="20" fill={C.wood} />
      <g fill={C.cream} opacity="0.8">
        <circle cx="40" cy="66" r="2.5" />
        <circle cx="56" cy="62" r="2.5" />
        <circle cx="48" cy="76" r="2.5" />
      </g>
      <circle cx="50" cy="46" r="18" fill={C.wood} />
      <ellipse cx="50" cy="56" rx="9" ry="6" fill={C.sand} />
      <ellipse cx="50" cy="55" rx="3" ry="2.2" fill={C.ink} />
      <Eyes y={44} dx={8} />
      <path d="M40 86 v6 M60 86 v6" stroke={C.woodDeep} strokeWidth="4" strokeLinecap="round" />
    </g>
  );
}

export function Penguin01(): ReactElement {
  return (
    <g>
      <Shadow />
      <ellipse cx="50" cy="60" rx="26" ry="32" fill={C.night} />
      <ellipse cx="50" cy="66" rx="18" ry="24" fill={C.cream} />
      <ellipse cx="26" cy="62" rx="6" ry="16" fill={C.night} transform="rotate(14 26 62)" />
      <ellipse cx="74" cy="62" rx="6" ry="16" fill={C.night} transform="rotate(-14 74 62)" />
      <ellipse cx="50" cy="42" rx="14" ry="10" fill={C.cream} />
      <circle cx="44" cy="40" r="2.4" fill={C.ink} />
      <circle cx="56" cy="40" r="2.4" fill={C.ink} />
      <path d="M46 47 l4 4 l4 -4 z" fill={C.orange} />
      <Cheeks y={46} dx={11} />
      <ellipse cx="40" cy="91" rx="8" ry="3.5" fill={C.orange} />
      <ellipse cx="60" cy="91" rx="8" ry="3.5" fill={C.orange} />
    </g>
  );
}
