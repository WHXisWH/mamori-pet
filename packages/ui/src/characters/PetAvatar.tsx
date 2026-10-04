import type { CharacterId, Expression } from '@ijime/api-types';
import type { CSSProperties, ReactElement } from 'react';

import { CHARACTER_META } from './meta.js';

export type PetAvatarProps = {
  characterId: CharacterId;
  expression?: Expression;
  size?: number | string;
  animate?: boolean;
  className?: string;
  title?: string;
  style?: CSSProperties;
};

type Palette = { body: string; accent: string; shade: string; light: string };

const PALETTES: Record<CharacterId, Palette> = {
  moko: { body: '#fbf7f2', accent: '#f2b8c6', shade: '#e8d9cf', light: '#ffffff' },
  pokke: { body: '#f6a96b', accent: '#fff1e0', shade: '#d97b3a', light: '#ffd9b8' },
  togemaru: { body: '#f3c96b', accent: '#8a5a3c', shade: '#c99a4a', light: '#fbe7b3' },
  nami: { body: '#3f739f', accent: '#9fd9c8', shade: '#2f5f8f', light: '#6f9fc8' },
  hoshi: { body: '#33406b', accent: '#f1c76b', shade: '#2b3557', light: '#4c5a8e' },
  hidden: { body: '#efe6d6', accent: '#c9b8d9', shade: '#d9ccb8', light: '#fff9ee' },
};

const INK = '#3b3a36';
const BLUSH = '#f7b8c4';

export function PetAvatar({
  characterId,
  expression = 'happy',
  size = 160,
  animate = true,
  className,
  title,
  style,
}: PetAvatarProps): ReactElement {
  const palette = PALETTES[characterId];
  const label =
    title ?? `${CHARACTER_META[characterId].displayName}（${expressionLabel(expression)}）`;
  const bodyClass = animate ? 'pet-body' : undefined;
  return (
    <svg
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={className}
      style={style}
      data-character={characterId}
      data-expression={expression}
    >
      <style>{`
        .pet-body { animation: pet-bob 4s ease-in-out infinite; transform-origin: 100px 190px; }
        .pet-eye { animation: pet-blink 5.2s infinite; transform-box: fill-box; transform-origin: center; }
        .pet-eye.delay { animation-delay: 0.08s; }
        .pet-sparkle { animation: twinkle 2.4s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
        .pet-sparkle.b { animation-delay: 0.8s; }
        .pet-zzz { animation: pet-float 3s ease-in-out infinite; }
        @keyframes pet-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
        @keyframes pet-blink { 0%,92%,100% { transform: scaleY(1) } 95% { transform: scaleY(0.08) } }
        @keyframes twinkle { 0%,100% { opacity: .3; transform: scale(.8) } 50% { opacity: 1; transform: scale(1.1) } }
        @keyframes pet-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }
        @media (prefers-reduced-motion: reduce) { .pet-body, .pet-eye, .pet-sparkle, .pet-zzz { animation: none } }
      `}</style>
      <ellipse cx="100" cy="188" rx="58" ry="7" fill={INK} opacity="0.08" />
      <g className={bodyClass}>
        {renderBody(characterId, palette)}
        <Face
          characterId={characterId}
          expression={expression}
          palette={palette}
          animate={animate}
        />
      </g>
      {expression === 'celebrate' && <Sparkles />}
      {expression === 'sleepy' && <Zzz />}
    </svg>
  );
}

function renderBody(id: CharacterId, p: Palette): ReactElement {
  switch (id) {
    case 'moko':
      return <MokoBody p={p} />;
    case 'pokke':
      return <PokkeBody p={p} />;
    case 'togemaru':
      return <TogemaruBody p={p} />;
    case 'nami':
      return <NamiBody p={p} />;
    case 'hoshi':
      return <HoshiBody p={p} />;
    case 'hidden':
      return <HiddenBody p={p} />;
  }
}

function MokoBody({ p }: { p: Palette }) {
  const puffs = [
    [55, 120, 30],
    [80, 100, 34],
    [115, 96, 36],
    [148, 118, 30],
    [65, 150, 30],
    [100, 158, 34],
    [138, 150, 30],
  ] as const;
  return (
    <g>
      {puffs.map(([cx, cy, r]) => (
        <circle
          key={`${cx}-${cy}`}
          cx={cx}
          cy={cy}
          r={r}
          fill={p.body}
          stroke={p.shade}
          strokeWidth="2"
        />
      ))}
      <ellipse cx="100" cy="132" rx="58" ry="44" fill={p.body} />
      <ellipse cx="100" cy="128" rx="40" ry="34" fill={p.accent} opacity="0.55" />
      <ellipse cx="56" cy="128" rx="9" ry="14" fill={p.accent} transform="rotate(-20 56 128)" />
      <ellipse cx="144" cy="128" rx="9" ry="14" fill={p.accent} transform="rotate(20 144 128)" />
      <rect x="78" y="168" width="12" height="16" rx="6" fill={p.shade} />
      <rect x="110" y="168" width="12" height="16" rx="6" fill={p.shade} />
    </g>
  );
}

function PokkeBody({ p }: { p: Palette }) {
  return (
    <g>
      <path d="M150 150 q40 -20 30 -60 q-6 30 -34 44 z" fill={p.body} />
      <path d="M170 105 q8 20 -6 32 q-2 -18 -12 -26 z" fill={p.accent} />
      <path d="M58 92 L48 40 L92 76 Z" fill={p.body} />
      <path d="M142 92 L152 40 L108 76 Z" fill={p.body} />
      <path d="M62 86 L56 54 L84 78 Z" fill={p.accent} />
      <path d="M138 86 L144 54 L116 78 Z" fill={p.accent} />
      <ellipse cx="100" cy="128" rx="60" ry="52" fill={p.body} />
      <ellipse cx="100" cy="146" rx="36" ry="26" fill={p.accent} />
      <ellipse cx="100" cy="117" rx="5" ry="3.5" fill={INK} />
      <rect x="72" y="172" width="14" height="14" rx="7" fill={p.shade} />
      <rect x="114" y="172" width="14" height="14" rx="7" fill={p.shade} />
    </g>
  );
}

function TogemaruBody({ p }: { p: Palette }) {
  const spikes = Array.from({ length: 9 }, (_, i) => {
    const a = Math.PI * (0.12 + (i / 8) * 0.76);
    const x1 = 100 + Math.cos(a) * 52;
    const y1 = 122 - Math.sin(a) * 48;
    const x2 = 100 + Math.cos(a) * 78;
    const y2 = 122 - Math.sin(a) * 76;
    const off = Math.PI / 22;
    return `M${100 + Math.cos(a - off) * 50} ${122 - Math.sin(a - off) * 46} L${x2} ${y2} L${100 + Math.cos(a + off) * 50} ${122 - Math.sin(a + off) * 46} Z ${x1} ${y1}`;
  });
  return (
    <g>
      {spikes.map((d, i) => (
        <path key={i} d={d.split(' Z ')[0] + ' Z'} fill={p.accent} />
      ))}
      <ellipse cx="100" cy="128" rx="60" ry="50" fill={p.accent} />
      <ellipse cx="100" cy="134" rx="50" ry="40" fill={p.body} />
      <ellipse cx="100" cy="117" rx="6" ry="4.5" fill={INK} />
      <rect x="74" y="172" width="14" height="14" rx="7" fill={p.accent} />
      <rect x="112" y="172" width="14" height="14" rx="7" fill={p.accent} />
    </g>
  );
}

function NamiBody({ p }: { p: Palette }) {
  return (
    <g>
      <circle cx="52" cy="82" r="14" fill={p.body} />
      <circle cx="148" cy="82" r="14" fill={p.body} />
      <circle cx="52" cy="82" r="7" fill={p.light} />
      <circle cx="148" cy="82" r="7" fill={p.light} />
      <ellipse cx="100" cy="128" rx="60" ry="54" fill={p.body} />
      <ellipse cx="100" cy="146" rx="38" ry="28" fill={p.accent} />
      <ellipse cx="100" cy="117" rx="6" ry="4" fill={INK} />
      <path
        d="M70 116 q-18 -4 -30 2"
        stroke={INK}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M70 122 q-18 2 -30 8"
        stroke={INK}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M130 116 q18 -4 30 2"
        stroke={INK}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M130 122 q18 2 30 8"
        stroke={INK}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <ellipse cx="80" cy="180" rx="14" ry="7" fill={p.shade} />
      <ellipse cx="120" cy="180" rx="14" ry="7" fill={p.shade} />
    </g>
  );
}

function HoshiBody({ p }: { p: Palette }) {
  return (
    <g>
      <path d="M52 78 L44 44 L74 66 Z" fill={p.body} />
      <path d="M148 78 L156 44 L126 66 Z" fill={p.body} />
      <ellipse cx="100" cy="128" rx="60" ry="56" fill={p.body} />
      <path d="M46 120 q-14 30 6 52 q10 -30 6 -52 z" fill={p.shade} />
      <path d="M154 120 q14 30 -6 52 q-10 -30 -6 -52 z" fill={p.shade} />
      <ellipse cx="100" cy="150" rx="34" ry="24" fill={p.light} opacity="0.6" />
      <circle cx="75" cy="96" r="22" fill={p.accent} opacity="0.95" />
      <circle cx="125" cy="96" r="22" fill={p.accent} opacity="0.95" />
      <path d="M94 118 L106 118 L100 128 Z" fill={p.accent} />
      <path
        d="M86 184 l4 -8 l4 8 M106 184 l4 -8 l4 8"
        stroke={p.accent}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="160" cy="40" r="2.5" fill={p.accent} className="pet-sparkle" />
      <circle cx="36" cy="30" r="2" fill={p.accent} className="pet-sparkle b" />
    </g>
  );
}

function HiddenBody({ p }: { p: Palette }) {
  return (
    <g>
      <path
        d="M100 40 C60 40 44 92 44 128 C44 162 68 184 100 184 C132 184 156 162 156 128 C156 92 140 40 100 40 Z"
        fill={p.body}
        stroke={p.shade}
        strokeWidth="2"
      />
      <circle cx="70" cy="80" r="6" fill={p.accent} />
      <circle cx="132" cy="70" r="4" fill={p.accent} />
      <circle cx="140" cy="150" r="7" fill={p.accent} />
      <circle cx="62" cy="150" r="5" fill={p.accent} />
      <text
        x="100"
        y="66"
        textAnchor="middle"
        fontSize="28"
        fontWeight="700"
        fill={p.shade}
        fontFamily="system-ui, sans-serif"
      >
        ?
      </text>
      <path
        d="M56 162 l8 -8 l8 8 l8 -8 l8 8"
        stroke={p.accent}
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

function Face({
  characterId,
  expression,
  palette,
  animate,
}: {
  characterId: CharacterId;
  expression: Expression;
  palette: Palette;
  animate: boolean;
}) {
  const eyeY = characterId === 'hoshi' ? 96 : characterId === 'hidden' ? 112 : 100;
  const mouthY =
    characterId === 'hoshi'
      ? 0
      : characterId === 'hidden'
        ? 136
        : characterId === 'moko'
          ? 124
          : 130;
  const eyeR = characterId === 'hoshi' ? 11 : 8;
  const eyeClass =
    animate && expression !== 'sleepy' && expression !== 'celebrate' ? 'pet-eye' : undefined;
  const showBlush =
    expression === 'happy' ||
    expression === 'together' ||
    expression === 'celebrate' ||
    expression === 'caring';
  return (
    <g>
      {showBlush && characterId !== 'hoshi' && (
        <>
          <ellipse cx="66" cy={eyeY + 16} rx="9" ry="5" fill={BLUSH} opacity="0.7" />
          <ellipse cx="134" cy={eyeY + 16} rx="9" ry="5" fill={BLUSH} opacity="0.7" />
        </>
      )}
      <Eye
        cx={75}
        cy={eyeY}
        r={eyeR}
        expression={expression}
        className={eyeClass}
        light={palette.light}
      />
      <Eye
        cx={125}
        cy={eyeY}
        r={eyeR}
        expression={expression}
        className={eyeClass ? `${eyeClass} delay` : undefined}
        light={palette.light}
      />
      <Brows cy={eyeY} expression={expression} />
      {mouthY > 0 && <Mouth cy={mouthY} expression={expression} />}
    </g>
  );
}

function Eye({
  cx,
  cy,
  r,
  expression,
  className,
  light,
}: {
  cx: number;
  cy: number;
  r: number;
  expression: Expression;
  className: string | undefined;
  light: string;
}) {
  if (expression === 'sleepy') {
    return (
      <path
        d={`M${cx - r} ${cy} q${r} ${r * 0.9} ${r * 2} 0`}
        stroke={INK}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
    );
  }
  if (expression === 'celebrate') {
    return (
      <path
        d={`M${cx - r} ${cy + 2} q${r} -${r * 1.2} ${r * 2} 0`}
        stroke={INK}
        strokeWidth="3.5"
        fill="none"
        strokeLinecap="round"
      />
    );
  }
  const ry = expression === 'caring' || expression === 'together' ? r * 0.8 : r;
  return (
    <g className={className}>
      <ellipse cx={cx} cy={cy} rx={r} ry={ry} fill={INK} />
      <circle
        cx={cx + r * 0.35}
        cy={cy - ry * 0.35}
        r={r * 0.32}
        fill={light === '#ffffff' ? '#ffffff' : '#fff'}
      />
    </g>
  );
}

function Brows({ cy, expression }: { cy: number; expression: Expression }) {
  const y = cy - 16;
  if (expression === 'worried') {
    return (
      <g stroke={INK} strokeWidth="3" fill="none" strokeLinecap="round">
        <path d={`M64 ${y + 2} q10 -6 20 0`} />
        <path d={`M116 ${y - 4} q10 6 20 0`} transform="" />
      </g>
    );
  }
  if (expression === 'caring') {
    return (
      <g stroke={INK} strokeWidth="2.5" fill="none" strokeLinecap="round" opacity="0.7">
        <path d={`M66 ${y} q9 -4 18 -1`} />
        <path d={`M116 ${y - 1} q9 -3 18 1`} />
      </g>
    );
  }
  return null;
}

function Mouth({ cy, expression }: { cy: number; expression: Expression }) {
  const common = { stroke: INK, strokeWidth: 3, fill: 'none', strokeLinecap: 'round' as const };
  switch (expression) {
    case 'happy':
      return <path d={`M88 ${cy} q12 12 24 0`} {...common} />;
    case 'together':
      return <path d={`M90 ${cy} q10 8 20 0`} {...common} />;
    case 'celebrate':
      return <path d={`M84 ${cy - 2} q16 22 32 0 z`} fill={INK} stroke="none" />;
    case 'caring':
      return <path d={`M92 ${cy} q8 6 16 0`} {...common} />;
    case 'sleepy':
      return <ellipse cx="100" cy={cy + 2} rx="5" ry="6" fill={INK} />;
    case 'worried':
      return <path d={`M88 ${cy + 2} q6 -6 12 0 q6 6 12 0`} {...common} />;
  }
}

function Sparkles() {
  return (
    <g fill="#f4c95d">
      <path className="pet-sparkle" d="M30 60 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 l10 -4 z" />
      <path className="pet-sparkle b" d="M168 48 l3 8 l8 3 l-8 3 l-3 8 l-3 -8 l-8 -3 l8 -3 z" />
      <circle className="pet-sparkle" cx="160" cy="100" r="3" />
      <circle className="pet-sparkle b" cx="40" cy="30" r="2.5" />
    </g>
  );
}

function Zzz() {
  return (
    <g className="pet-zzz" fill="#6b9ac4" fontFamily="system-ui, sans-serif" fontWeight="700">
      <text x="150" y="70" fontSize="18">
        z
      </text>
      <text x="164" y="52" fontSize="14">
        z
      </text>
      <text x="176" y="40" fontSize="10">
        z
      </text>
    </g>
  );
}

function expressionLabel(e: Expression): string {
  return (
    {
      happy: 'うれしい',
      caring: 'きにかけている',
      sleepy: 'ねむい',
      together: 'いっしょ',
      celebrate: 'おめでとう',
      worried: 'しんぱい',
    } satisfies Record<Expression, string>
  )[e];
}
