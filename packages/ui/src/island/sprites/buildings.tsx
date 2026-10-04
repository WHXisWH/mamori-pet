import type { ReactElement } from 'react';

import { ISLAND_COLORS as C } from '../palette.js';

function Shadow({ rx = 30 }: { rx?: number }): ReactElement {
  return <ellipse cx="50" cy="94" rx={rx} ry="4" fill={C.ink} opacity="0.08" />;
}

export function House01(): ReactElement {
  return (
    <g>
      <Shadow />
      <rect x="24" y="48" width="52" height="44" rx="4" fill={C.cream} />
      <path d="M16 52 L50 20 L84 52 Z" fill={C.coral} />
      <rect x="60" y="24" width="8" height="14" rx="2" fill={C.woodDeep} />
      <rect x="42" y="66" width="16" height="26" rx="6" fill={C.woodDeep} />
      <rect
        x="30"
        y="58"
        width="10"
        height="10"
        rx="2"
        fill={C.calmSoft}
        stroke={C.calm}
        strokeWidth="1.5"
      />
      <rect
        x="62"
        y="58"
        width="10"
        height="10"
        rx="2"
        fill={C.calmSoft}
        stroke={C.calm}
        strokeWidth="1.5"
      />
      <circle cx="54" cy="80" r="1.6" fill={C.sun} />
    </g>
  );
}

export function School01(): ReactElement {
  return (
    <g>
      <Shadow rx={36} />
      <rect x="12" y="46" width="76" height="46" rx="4" fill={C.sand} />
      <rect x="38" y="30" width="24" height="20" rx="3" fill={C.sand} />
      <path d="M34 32 L50 18 L66 32 Z" fill={C.calm} />
      <circle cx="50" cy="40" r="5" fill={C.cream} stroke={C.calmDeep} strokeWidth="1.5" />
      <path d="M50 40 v-3 M50 40 h2" stroke={C.calmDeep} strokeWidth="1.2" strokeLinecap="round" />
      <g fill={C.calmSoft} stroke={C.calm} strokeWidth="1.5">
        <rect x="18" y="54" width="10" height="10" rx="2" />
        <rect x="34" y="54" width="10" height="10" rx="2" />
        <rect x="56" y="54" width="10" height="10" rx="2" />
        <rect x="72" y="54" width="10" height="10" rx="2" />
        <rect x="18" y="72" width="10" height="10" rx="2" />
        <rect x="72" y="72" width="10" height="10" rx="2" />
      </g>
      <rect x="40" y="70" width="20" height="22" rx="4" fill={C.woodDeep} />
    </g>
  );
}

export function Tent01(): ReactElement {
  return (
    <g>
      <Shadow rx={36} />
      <path d="M12 90 L50 26 L88 90 Z" fill={C.orange} />
      <path d="M50 26 L36 90 H64 Z" fill={C.cream} />
      <path d="M50 26 L50 90" stroke={C.orangeDeep} strokeWidth="1.5" />
      <path
        d="M46 20 l4 6 l4 -6"
        stroke={C.woodDeep}
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M50 42 L42 90 H58 Z" fill={C.woodDeep} opacity="0.25" />
    </g>
  );
}

export function Treehouse01(): ReactElement {
  return (
    <g>
      <Shadow rx={28} />
      <rect x="44" y="60" width="12" height="34" rx="6" fill={C.woodDeep} />
      <circle cx="50" cy="48" r="30" fill={C.leaf} />
      <circle cx="30" cy="58" r="14" fill={C.leaf} />
      <circle cx="72" cy="58" r="14" fill={C.leaf} />
      <rect x="34" y="40" width="32" height="24" rx="3" fill={C.wood} />
      <path d="M30 42 L50 26 L70 42 Z" fill={C.woodDeep} />
      <rect x="44" y="50" width="12" height="14" rx="5" fill={C.woodDeep} />
      <rect x="36" y="46" width="6" height="6" rx="1.5" fill={C.calmSoft} />
      <g stroke={C.wood} strokeWidth="2.5" strokeLinecap="round">
        <path d="M60 66 v26 M66 66 v26 M60 72 h6 M60 80 h6 M60 88 h6" />
      </g>
    </g>
  );
}

export function Lighthouse01(): ReactElement {
  return (
    <g>
      <Shadow rx={22} />
      <path d="M36 92 L40 36 H60 L64 92 Z" fill={C.cream} />
      <path d="M39 52 L61 52 L61.5 60 L38.5 60 Z" fill={C.coral} />
      <path d="M37.5 72 L62.5 72 L63 80 L37 80 Z" fill={C.coral} />
      <rect x="38" y="24" width="24" height="14" rx="3" fill={C.calmDeep} />
      <rect x="42" y="27" width="16" height="9" rx="2" fill={C.sun} />
      <path d="M34 22 L50 12 L66 22 Z" fill={C.coral} />
      <circle cx="50" cy="12" r="2.5" fill={C.sun} />
      <path d="M42 31 l-14 -6 v12 z M58 31 l14 -6 v12 z" fill={C.sun} opacity="0.3" />
    </g>
  );
}

export function Bench01(): ReactElement {
  return (
    <g>
      <Shadow rx={34} />
      <rect x="14" y="60" width="72" height="10" rx="4" fill={C.wood} />
      <rect x="18" y="40" width="64" height="8" rx="4" fill={C.wood} />
      <rect x="18" y="50" width="64" height="6" rx="3" fill={C.wood} />
      <g stroke={C.woodDeep} strokeWidth="5" strokeLinecap="round">
        <path d="M24 44 v46 M76 44 v46" />
      </g>
    </g>
  );
}

export function Table01(): ReactElement {
  return (
    <g>
      <Shadow rx={34} />
      <ellipse cx="50" cy="50" rx="36" ry="14" fill={C.cream} stroke={C.sandDeep} strokeWidth="2" />
      <g stroke={C.woodDeep} strokeWidth="5" strokeLinecap="round">
        <path d="M30 60 v28 M70 60 v28 M50 64 v26" />
      </g>
      <circle cx="50" cy="48" r="6" fill={C.sun} />
      <circle cx="46" cy="46" r="2" fill={C.coral} />
      <circle cx="54" cy="47" r="2" fill={C.calm} />
    </g>
  );
}

export function Swing01(): ReactElement {
  return (
    <g>
      <Shadow rx={34} />
      <path
        d="M18 92 L30 18 H70 L82 92"
        stroke={C.woodDeep}
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
      />
      <path d="M40 22 v46 M60 22 v46" stroke={C.inkSoft} strokeWidth="2" strokeLinecap="round" />
      <rect x="34" y="66" width="32" height="8" rx="4" fill={C.wood} />
    </g>
  );
}

export function Slide01(): ReactElement {
  return (
    <g>
      <Shadow rx={36} />
      <path
        d="M26 30 q0 -10 10 -10 h8 v12 q-6 2 -4 10 q6 30 46 48 q-20 6 -40 -10 q-14 -12 -20 -50 z"
        fill={C.calm}
      />
      <path
        d="M24 92 L34 36 M44 92 L44 36"
        stroke={C.woodDeep}
        strokeWidth="4"
        strokeLinecap="round"
      />
      <g stroke={C.woodDeep} strokeWidth="3" strokeLinecap="round">
        <path d="M30 50 h14 M28 64 h16 M26 78 h18" />
      </g>
      <path
        d="M40 34 q8 32 46 48"
        stroke={C.calmSoft}
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

export function Lantern01(): ReactElement {
  return (
    <g>
      <Shadow rx={18} />
      <rect x="46" y="54" width="8" height="38" rx="4" fill={C.inkSoft} />
      <rect x="34" y="20" width="32" height="34" rx="6" fill={C.inkSoft} />
      <rect x="38" y="24" width="24" height="26" rx="4" fill={C.sun} />
      <circle cx="50" cy="37" r="14" fill={C.sun} opacity="0.35" />
      <path d="M42 20 L50 10 L58 20 Z" fill={C.inkSoft} />
      <circle cx="50" cy="37" r="5" fill={C.cream} />
    </g>
  );
}

export function Mailbox01(): ReactElement {
  return (
    <g>
      <Shadow rx={18} />
      <rect x="46" y="60" width="8" height="32" rx="4" fill={C.woodDeep} />
      <rect x="28" y="28" width="44" height="34" rx="12" fill={C.coral} />
      <rect x="34" y="40" width="32" height="5" rx="2.5" fill={C.cream} />
      <circle cx="50" cy="52" r="3" fill={C.cream} />
      <path d="M68 24 h6 v8 h-6 z" fill={C.sun} />
    </g>
  );
}

export function Bookshelf01(): ReactElement {
  return (
    <g>
      <Shadow rx={30} />
      <rect x="22" y="18" width="56" height="74" rx="4" fill={C.wood} />
      <rect x="26" y="22" width="48" height="30" rx="2" fill={C.cream} />
      <rect x="26" y="58" width="48" height="30" rx="2" fill={C.cream} />
      <g>
        <rect x="30" y="28" width="7" height="24" rx="1.5" fill={C.coral} />
        <rect x="39" y="32" width="6" height="20" rx="1.5" fill={C.calm} />
        <rect x="47" y="26" width="8" height="26" rx="1.5" fill={C.sun} />
        <rect x="57" y="34" width="6" height="18" rx="1.5" fill={C.leaf} />
        <rect x="65" y="30" width="6" height="22" rx="1.5" fill={C.lilac} />
        <rect x="30" y="66" width="8" height="22" rx="1.5" fill={C.leaf} />
        <rect x="40" y="62" width="6" height="26" rx="1.5" fill={C.coral} />
        <rect x="48" y="70" width="10" height="18" rx="1.5" fill={C.calm} />
        <rect x="60" y="66" width="7" height="22" rx="1.5" fill={C.sun} />
      </g>
    </g>
  );
}
