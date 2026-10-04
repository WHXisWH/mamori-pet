import type { CharacterId, Expression } from '@ijime/api-types';
import { PetAvatar } from '@ijime/ui';
import type { CSSProperties, ReactNode } from 'react';

import { BlurFilter, Layer, LightLayer } from './Layer';

export type TimeOfDay = 'morning' | 'afternoon' | 'evening' | 'night';

export type Spot = { x: number; y: number; size: number };

export type PetPlacement = Spot & {
  characterId: CharacterId;
  expression: Expression;
  mobile?: Spot | undefined;
  testId?: string | undefined;
};

export type SceneProps = {
  uid: string;
  pet: PetPlacement;
};

export function petTop(spot: Spot): number {
  return spot.y - spot.size * 0.95;
}

function spotVars(d: [number, number], m?: [number, number], k = 1): CSSProperties {
  return {
    ['--tx' as string]: d[0],
    ['--ty' as string]: d[1],
    ['--tx-m' as string]: (m ?? d)[0],
    ['--ty-m' as string]: (m ?? d)[1],
    ['--k-m' as string]: k,
  };
}

function Placed({
  at,
  mobile,
  children,
}: {
  at: [number, number];
  mobile?: [number, number];
  children: ReactNode;
}) {
  return (
    <g className="spot" style={spotVars(at, mobile)}>
      {children}
    </g>
  );
}

const GRADE: Record<TimeOfDay, { tint: string; tintOpacity: number; petFilter: string }> = {
  morning: { tint: '#e4eeff', tintOpacity: 0.14, petFilter: 'none' },
  afternoon: { tint: '#ffe7cc', tintOpacity: 0.18, petFilter: 'none' },
  evening: { tint: '#6e5566', tintOpacity: 0.6, petFilter: 'brightness(0.92) saturate(0.95)' },
  night: { tint: '#17204a', tintOpacity: 0.8, petFilter: 'brightness(0.86) saturate(0.88)' },
};

function Tint({ time }: { time: TimeOfDay }) {
  const g = GRADE[time];
  return (
    <rect
      width="1600"
      height="900"
      fill={g.tint}
      opacity={g.tintOpacity}
      style={{ mixBlendMode: 'multiply' }}
    />
  );
}

function GradeFilter({ uid, time }: { uid: string; time: TimeOfDay }) {
  const g = GRADE[time];
  return (
    <filter
      id={`${uid}-grade`}
      x="0"
      y="0"
      width="100%"
      height="100%"
      colorInterpolationFilters="sRGB"
    >
      <feFlood floodColor={g.tint} floodOpacity={g.tintOpacity} result="tint" />
      <feComposite in="tint" in2="SourceGraphic" operator="in" result="clipped" />
      <feBlend in="clipped" in2="SourceGraphic" mode="multiply" />
    </filter>
  );
}

function Graded({ uid, children }: { uid: string; children: ReactNode }) {
  return <g filter={`url(#${uid}-grade)`}>{children}</g>;
}

function PetLayer({ pet, depth, filter }: { pet: PetPlacement; depth: number; filter: string }) {
  const m = pet.mobile ?? pet;
  return (
    <Layer depth={depth} style={{ filter } as CSSProperties}>
      <g
        className="spot"
        style={spotVars(
          [pet.x - pet.size / 2, petTop(pet)],
          [m.x - m.size / 2, petTop(m)],
          m.size / pet.size,
        )}
        {...(pet.testId ? { 'data-testid': pet.testId } : {})}
      >
        <PetAvatar characterId={pet.characterId} expression={pet.expression} size={pet.size} />
      </g>
    </Layer>
  );
}

function Window({ time, uid }: { time: TimeOfDay; uid: string }) {
  const sky =
    time === 'morning'
      ? ['#a9d2f2', '#f4f1e6']
      : time === 'afternoon'
        ? ['#ffd49e', '#fff2dc']
        : time === 'evening'
          ? ['#34427a', '#e39a8a']
          : ['#0b1330', '#1d2a58'];
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-sky`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={sky[0]} />
          <stop offset="1" stopColor={sky[1]} />
        </linearGradient>
        <radialGradient id={`${uid}-sun`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={time === 'night' ? '#fff5da' : '#fffaf0'} stopOpacity="1" />
          <stop offset="1" stopColor={time === 'night' ? '#fff5da' : '#fffaf0'} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="560" y="90" width="480" height="420" rx="10" fill="#fbf3ea" />
      <rect x="580" y="110" width="440" height="380" fill={`url(#${uid}-sky)`} />
      {time === 'afternoon' && (
        <g>
          <circle cx="930" cy="190" r="170" fill={`url(#${uid}-sun)`} opacity="0.9" />
          <path
            d="M580 440 L640 410 L700 425 L760 395 L840 420 L900 400 L980 428 L1020 415 L1020 490 L580 490 Z"
            fill="#efcfae"
          />
          <path
            d="M580 465 L660 445 L720 458 L800 440 L880 462 L960 448 L1020 460 L1020 490 L580 490 Z"
            fill="#e7bf9c"
          />
        </g>
      )}
      {time === 'morning' && (
        <g>
          <circle cx="690" cy="330" r="150" fill={`url(#${uid}-sun)`} opacity="0.85" />
          <path
            d="M600 200 q14 -10 28 0 q14 -10 28 0"
            stroke="#6f8aa3"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M880 170 q10 -7 20 0 q10 -7 20 0"
            stroke="#6f8aa3"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
          />
          <path
            d="M580 440 L640 418 L700 430 L760 404 L840 426 L900 408 L980 432 L1020 420 L1020 490 L580 490 Z"
            fill="#cfe1d6"
          />
          <path
            d="M580 465 L660 448 L720 460 L800 444 L880 464 L960 450 L1020 462 L1020 490 L580 490 Z"
            fill="#b7d1c0"
          />
        </g>
      )}
      {time === 'evening' && (
        <g>
          <path
            d="M580 420 L640 405 L640 380 L700 380 L700 410 L770 400 L770 360 L820 360 L820 405 L900 395 L900 370 L960 370 L960 410 L1020 400 L1020 490 L580 490 Z"
            fill="#2b2d4d"
          />
          {[
            [652, 392],
            [712, 402],
            [785, 372],
            [800, 390],
            [915, 382],
            [940, 398],
            [975, 420],
            [620, 440],
            [860, 440],
          ].map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="6" height="8" fill="#ffd37a" opacity="0.9" />
          ))}
        </g>
      )}
      {time === 'night' && (
        <g>
          <circle cx="900" cy="195" r="120" fill={`url(#${uid}-sun)`} opacity="0.45" />
          <circle cx="900" cy="195" r="34" fill="#fff4d8" />
          {[
            [640, 150, 1.8],
            [700, 240, 1.2],
            [760, 170, 1.5],
            [980, 290, 1.3],
            [620, 330, 1.1],
            [990, 140, 1.6],
            [700, 360, 1],
          ].map(([x, y, r]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="#ffffff" />
          ))}
          <path
            d="M580 430 L660 420 L660 400 L720 400 L720 425 L800 415 L880 428 L880 405 L940 405 L940 430 L1020 422 L1020 490 L580 490 Z"
            fill="#0e1330"
          />
          {[
            [676, 410],
            [900, 415],
            [920, 440],
          ].map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="6" height="8" fill="#ffd37a" opacity="0.8" />
          ))}
        </g>
      )}
      <rect x="795" y="110" width="10" height="380" fill="#fbf3ea" />
      <rect x="580" y="292" width="440" height="8" fill="#fbf3ea" />
      <rect x="540" y="500" width="520" height="22" rx="4" fill="#f1e2d0" />
      <rect x="540" y="520" width="520" height="8" fill="#d8c0a6" opacity="0.7" />
    </g>
  );
}

function WindowGlow({ time, uid }: { time: TimeOfDay; uid: string }) {
  if (time === 'afternoon' || time === 'morning') return null;
  if (time === 'evening') {
    return (
      <g style={{ mixBlendMode: 'screen' }}>
        <defs>
          <linearGradient id={`${uid}-dusk`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#5a6aa8" stopOpacity="0.25" />
            <stop offset="0.75" stopColor="#f0a58f" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ffc59a" stopOpacity="0.7" />
          </linearGradient>
        </defs>
        <rect x="580" y="110" width="440" height="380" fill={`url(#${uid}-dusk)`} />
        {[
          [652, 392],
          [712, 402],
          [785, 372],
          [915, 382],
          [975, 420],
          [860, 440],
        ].map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="6" height="8" fill="#ffd37a" opacity="0.8" />
        ))}
      </g>
    );
  }
  return (
    <g style={{ mixBlendMode: 'screen' }}>
      <rect x="580" y="110" width="440" height="380" fill="#2a3f86" opacity="0.35" />
      <circle cx="900" cy="195" r="150" fill={`url(#${uid}-sun)`} opacity="0.35" />
      <circle cx="900" cy="195" r="30" fill="#fff4d8" opacity="0.95" />
      {[
        [640, 150, 1.8],
        [760, 170, 1.5],
        [990, 140, 1.6],
        [700, 250, 1.2],
      ].map(([x, y, r]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill="#ffffff" opacity="0.8" />
      ))}
      <rect x="540" y="500" width="520" height="4" fill="#b9cffa" opacity="0.45" />
    </g>
  );
}

function Curtains({ time }: { time: TimeOfDay }) {
  const op = time === 'afternoon' || time === 'morning' ? 0.55 : time === 'evening' ? 0.4 : 0.3;
  return (
    <g opacity={op}>
      <g>
        <path
          d="M470 70 L600 70 C590 220 610 380 596 560 L470 560 C488 380 460 220 470 70 Z"
          fill="#ffffff"
        />
        <path d="M500 70 C496 240 512 400 500 560" stroke="#efe2d4" strokeWidth="6" fill="none" />
        <path d="M545 70 C541 240 556 400 548 560" stroke="#efe2d4" strokeWidth="5" fill="none" />
      </g>
      <g>
        <path
          d="M1000 70 L1130 70 C1140 220 1112 380 1130 560 L1004 560 C990 380 1010 220 1000 70 Z"
          fill="#ffffff"
        />
        <path
          d="M1050 70 C1046 240 1062 400 1052 560"
          stroke="#efe2d4"
          strokeWidth="5"
          fill="none"
        />
        <path
          d="M1095 70 C1091 240 1106 400 1098 560"
          stroke="#efe2d4"
          strokeWidth="6"
          fill="none"
        />
      </g>
      <rect x="450" y="58" width="700" height="12" rx="6" fill="#c9a37a" />
    </g>
  );
}

function Bookshelf() {
  const books = [
    ['#c97d6b', 30, 118],
    ['#7fa38a', 22, 104],
    ['#e0b86a', 34, 124],
    ['#6b8fb3', 26, 112],
    ['#b48ab8', 20, 98],
    ['#d9a0a0', 30, 116],
  ] as const;
  return (
    <g>
      <rect x="170" y="250" width="270" height="470" rx="10" fill="#b98457" />
      <rect x="186" y="266" width="238" height="438" fill="#8f623c" />
      {[400, 540].map((y) => (
        <rect key={y} x="186" y={y} width="238" height="12" fill="#c7925f" />
      ))}
      {[266, 412].map((shelfTop) => {
        let x = 196;
        return books.map(([c, w, h], i) => {
          const el = (
            <rect
              key={`${shelfTop}-${i}`}
              x={x}
              y={shelfTop + 134 - h}
              width={w}
              height={h}
              rx="3"
              fill={c}
            />
          );
          x += w + 4;
          return el;
        });
      })}
      <rect
        x="360"
        y="440"
        width="22"
        height="100"
        rx="3"
        fill="#7fa38a"
        transform="rotate(-12 371 540)"
      />
      <g transform="translate(250 552)">
        <rect x="0" y="80" width="90" height="70" rx="10" fill="#e9d6c1" />
        <path d="M45 82 C10 40 0 10 20 0 C30 30 40 50 45 82 Z" fill="#7fb77e" />
        <path d="M45 82 C60 30 80 12 96 20 C80 40 60 60 45 82 Z" fill="#5f9c63" />
        <path d="M45 82 C40 40 48 12 60 -8 C62 30 54 60 45 82 Z" fill="#8fc48d" />
      </g>
      <g transform="translate(212 160)">
        <rect width="120" height="80" rx="6" fill="#fbf3ea" />
        <rect x="10" y="10" width="100" height="60" fill="#dbe7f3" />
        <circle cx="42" cy="44" r="14" fill="#f4c95d" />
        <path d="M10 70 L50 44 L80 60 L110 40 L110 70 Z" fill="#7fb77e" />
      </g>
    </g>
  );
}

function Randoseru({
  x,
  y,
  scale = 1,
  rotate = 0,
}: {
  x: number;
  y: number;
  scale?: number;
  rotate?: number;
}) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotate}) scale(${scale})`}>
      <rect x="0" y="20" width="120" height="140" rx="26" fill="#c2413b" />
      <path d="M0 60 C0 20 20 0 60 0 C100 0 120 20 120 60 L120 90 L0 90 Z" fill="#a8342f" />
      <rect x="48" y="84" width="24" height="16" rx="4" fill="#e7c36a" />
      <path d="M22 20 C22 -10 98 -10 98 20" stroke="#8b2a26" strokeWidth="8" fill="none" />
    </g>
  );
}

function Desk({ uid, time, tablet }: { uid: string; time: TimeOfDay; tablet: boolean }) {
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-wood`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#dcae7f" />
          <stop offset="1" stopColor="#b07a4e" />
        </linearGradient>
        <radialGradient id={`${uid}-screen`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#dff0ff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#dff0ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M320 690 L1280 690 L1420 900 L180 900 Z" fill={`url(#${uid}-wood)`} />
      <rect x="320" y="686" width="960" height="8" rx="3" fill="#f2cfa3" />
      <g transform="translate(380 596)">
        <rect x="0" y="16" width="64" height="84" rx="10" fill="#8fb3d6" />
        <rect
          x="10"
          y="-30"
          width="8"
          height="60"
          rx="3"
          fill="#f4c95d"
          transform="rotate(-10 14 0)"
        />
        <rect x="26" y="-44" width="8" height="70" rx="3" fill="#e5533d" />
        <rect
          x="42"
          y="-26"
          width="8"
          height="56"
          rx="3"
          fill="#7fb77e"
          transform="rotate(12 46 0)"
        />
      </g>
      <g transform="translate(540 712) skewX(-18)">
        <rect width="170" height="40" rx="4" fill="#fbf3ea" />
        <rect x="8" y="6" width="154" height="4" fill="#dbe7f3" />
      </g>
      <g>
        <rect x="1190" y="660" width="90" height="26" rx="10" fill="#6f6b63" />
        <path
          d="M1235 662 L1215 520 L1150 470"
          stroke="#6f6b63"
          strokeWidth="12"
          fill="none"
          strokeLinecap="round"
        />
        <path d="M1110 440 L1200 470 L1170 510 Z" fill="#8a8680" />
      </g>
      {tablet && (
        <Placed at={[700, 706]} mobile={[636, 706]}>
          <g transform="skewX(-14)">
            <ellipse
              cx="90"
              cy="16"
              rx="190"
              ry="70"
              fill={`url(#${uid}-screen)`}
              opacity={time === 'afternoon' || time === 'morning' ? 0.3 : 0.75}
            />
            <rect width="190" height="32" rx="6" fill="#2b2b33" />
            <rect x="8" y="4" width="174" height="24" rx="3" fill="#d8ebff" />
          </g>
        </Placed>
      )}
    </g>
  );
}

function LampLight({ uid }: { uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-cone`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#ffd08a" stopOpacity="0.85" />
          <stop offset="1" stopColor="#ffd08a" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${uid}-lamp`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffdca0" stopOpacity="0.95" />
          <stop offset="1" stopColor="#ffb86b" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="1150" cy="495" r="300" fill={`url(#${uid}-lamp)`} opacity="0.55" />
      <path
        d="M1120 490 L1185 505 L1330 760 L860 760 Z"
        fill={`url(#${uid}-cone)`}
        filter={`url(#${uid}-blur-md)`}
      />
      <ellipse
        cx="1060"
        cy="720"
        rx="300"
        ry="60"
        fill="#ffcf8a"
        opacity="0.35"
        filter={`url(#${uid}-blur-md)`}
      />
    </g>
  );
}

function SunBeam({ uid }: { uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-beam`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#fff1d2" stopOpacity="0.75" />
          <stop offset="1" stopColor="#fff1d2" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d="M620 130 L1010 130 L900 900 L300 900 Z"
        fill={`url(#${uid}-beam)`}
        filter={`url(#${uid}-blur-lg)`}
      />
      <path
        d="M700 130 L820 130 L640 900 L470 900 Z"
        fill="#fff6e2"
        opacity="0.18"
        filter={`url(#${uid}-blur-lg)`}
      />
    </g>
  );
}

function MoonBeam({ uid }: { uid: string }) {
  return (
    <g>
      <defs>
        <linearGradient id={`${uid}-moonbeam`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#b9cffa" stopOpacity="0.45" />
          <stop offset="1" stopColor="#b9cffa" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d="M600 130 L1010 130 L1320 900 L700 900 Z"
        fill={`url(#${uid}-moonbeam)`}
        filter={`url(#${uid}-blur-lg)`}
      />
    </g>
  );
}

function Futon({ uid }: { uid: string }) {
  return (
    <g>
      <defs>
        <radialGradient id={`${uid}-futonglow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffd9a0" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffd9a0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d="M1100 640 C1180 560 1520 560 1640 620 L1640 900 L1060 900 Z" fill="#dfe6f3" />
      <path
        d="M1180 640 C1240 560 1380 560 1440 630 C1460 680 1420 720 1330 730 C1240 735 1170 700 1180 640 Z"
        fill="#c7d3ea"
      />
      <ellipse
        cx="1300"
        cy="690"
        rx="120"
        ry="60"
        fill={`url(#${uid}-futonglow)`}
        style={{ mixBlendMode: 'screen' }}
      />
    </g>
  );
}

function Foreground({
  uid,
  time,
  randoseru,
}: {
  uid: string;
  time: TimeOfDay;
  randoseru: boolean;
}) {
  const bokeh = time === 'night' ? '#9fb8ff' : '#fff1d2';
  return (
    <g>
      <g filter={`url(#${uid}-blur-xl)`}>
        <path
          d="M1640 260 C1500 320 1440 460 1470 620 C1400 560 1350 600 1380 700 C1330 690 1300 760 1340 900 L1640 900 Z"
          fill={time === 'afternoon' || time === 'morning' ? '#6f9a5f' : '#2c3a33'}
        />
        <path
          d="M-40 520 C60 560 110 660 90 780 C150 740 190 790 160 900 L-40 900 Z"
          fill={time === 'afternoon' || time === 'morning' ? '#7fa86c' : '#26332d'}
        />
        {randoseru && <Randoseru x={110} y={640} scale={2.1} rotate={-14} />}
      </g>
      <g filter={`url(#${uid}-blur-md)`} style={{ mixBlendMode: 'screen' }}>
        {[
          [260, 120, 42],
          [1380, 180, 60],
          [1240, 90, 28],
          [420, 60, 22],
          [1480, 420, 34],
        ].map(([x, y, r]) => (
          <circle
            key={`${x}-${y}`}
            cx={x}
            cy={y}
            r={r}
            fill={bokeh}
            opacity={time === 'night' ? 0.18 : 0.28}
          />
        ))}
      </g>
    </g>
  );
}

function SharedDefs({ uid }: { uid: string }) {
  return (
    <defs>
      <BlurFilter id={`${uid}-blur-md`} amount={10} />
      <BlurFilter id={`${uid}-blur-lg`} amount={22} />
      <BlurFilter id={`${uid}-blur-xl`} amount={14} />
    </defs>
  );
}

export function petDepth(pet: PetPlacement): number {
  return pet.y < 600 ? 0.12 : 0.45;
}

export function RoomScene({
  uid,
  time,
  pet,
  randoseruOnFloor = false,
  tablet = false,
}: SceneProps & { time: TimeOfDay; randoseruOnFloor?: boolean; tablet?: boolean }) {
  const wall =
    time === 'morning'
      ? ['#f5ede4', '#e8dacb']
      : time === 'afternoon'
        ? ['#f7e5d2', '#eed1bd']
        : time === 'evening'
          ? ['#f2dcc8', '#e4c6b2']
          : ['#e6d8cc', '#d8c6b8'];
  return (
    <>
      <Layer depth={0.08}>
        <SharedDefs uid={uid} />
        <defs>
          <linearGradient id={`${uid}-wall`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={wall[0]} />
            <stop offset="1" stopColor={wall[1]} />
          </linearGradient>
        </defs>
        <rect width="1600" height="900" fill={`url(#${uid}-wall)`} />
        <rect y="700" width="1600" height="200" fill="#e2c3a6" />
        <Window time={time} uid={uid} />
        {!randoseruOnFloor && <Randoseru x={1170} y={330} scale={0.9} />}
        <Tint time={time} />
        <WindowGlow time={time} uid={uid} />
      </Layer>
      <Layer depth={0.08} inner={{ className: 'animate-sway', style: { transformOrigin: 'top' } }}>
        <defs>
          <GradeFilter uid={`${uid}-c`} time={time} />
        </defs>
        <Graded uid={`${uid}-c`}>
          <Curtains time={time} />
        </Graded>
      </Layer>
      {time !== 'evening' && (
        <LightLayer depth={0.08}>
          <SharedDefs uid={`${uid}-l`} />
          {time === 'night' ? <MoonBeam uid={`${uid}-l`} /> : <SunBeam uid={`${uid}-l`} />}
        </LightLayer>
      )}
      <Layer depth={0.22}>
        <SharedDefs uid={uid} />
        <defs>
          <GradeFilter uid={uid} time={time} />
        </defs>
        <Graded uid={uid}>
          <Bookshelf />
          {time === 'night' && <Futon uid={uid} />}
        </Graded>
      </Layer>
      <Layer depth={0.45}>
        <SharedDefs uid={uid} />
        <defs>
          <GradeFilter uid={uid} time={time} />
        </defs>
        <Graded uid={uid}>
          <Desk uid={uid} time={time} tablet={tablet} />
        </Graded>
        {tablet && (
          <Placed at={[700, 706]} mobile={[636, 706]}>
            <ellipse
              cx="95"
              cy="14"
              rx="150"
              ry="38"
              fill="#cfe6ff"
              opacity="0.35"
              style={{ mixBlendMode: 'screen' }}
              filter={`url(#${uid}-blur-md)`}
            />
          </Placed>
        )}
      </Layer>
      {time === 'evening' && (
        <LightLayer depth={0.45}>
          <SharedDefs uid={`${uid}-l`} />
          <LampLight uid={`${uid}-l`} />
        </LightLayer>
      )}
      <PetLayer pet={pet} depth={petDepth(pet)} filter={GRADE[time].petFilter} />
      <Layer depth={0.9}>
        <SharedDefs uid={uid} />
        <Foreground uid={uid} time={time} randoseru={randoseruOnFloor} />
      </Layer>
    </>
  );
}

export function HallwayScene({ uid, pet }: SceneProps) {
  return (
    <>
      <Layer depth={0.08}>
        <SharedDefs uid={uid} />
        <defs>
          <linearGradient id={`${uid}-door`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#ffe2ad" />
            <stop offset="1" stopColor="#ffb870" />
          </linearGradient>
          <radialGradient id={`${uid}-bloom`} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#ffcf8a" stopOpacity="0.9" />
            <stop offset="1" stopColor="#ffcf8a" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${uid}-spill`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#ffcf8a" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ffcf8a" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect width="1600" height="900" fill="#26243a" />
        <path d="M0 0 L640 300 L640 640 L0 900 Z" fill="#35304a" />
        <path d="M1600 0 L960 300 L960 640 L1600 900 Z" fill="#2e2a44" />
        <path d="M0 0 L1600 0 L960 300 L640 300 Z" fill="#221f34" />
        <path d="M0 900 L640 640 L960 640 L1600 900 Z" fill="#4a3a30" />
        {[-420, -210, 0, 210, 420].map((dx) => (
          <line
            key={dx}
            x1={800 + dx * 0.4}
            y1="640"
            x2={800 + dx * 2.6}
            y2="900"
            stroke="#3a2d25"
            strokeWidth="3"
          />
        ))}
        <path d="M130 250 L300 330 L300 470 L130 420 Z" fill="#4a4360" />
        <path d="M150 265 L285 330 L285 455 L150 410 Z" fill="#6b8fb3" opacity="0.45" />
        <path d="M1470 260 L1300 335 L1300 460 L1470 420 Z" fill="#4a4360" />
        <rect x="640" y="300" width="320" height="340" fill={`url(#${uid}-door)`} />
        <g filter={`url(#${uid}-blur-md)`}>
          <rect x="690" y="470" width="220" height="70" fill="#d99a5c" opacity="0.9" />
          <circle cx="872" cy="400" r="26" fill="#6b4a3a" />
          <path d="M836 430 C836 420 910 420 910 430 L918 560 L830 560 Z" fill="#6b4a3a" />
          <circle cx="740" cy="330" r="16" fill="#fff4dc" />
        </g>
      </Layer>
      <LightLayer depth={0.2}>
        <SharedDefs uid={`${uid}-l`} />
        <ellipse cx="800" cy="470" rx="420" ry="300" fill={`url(#${uid}-bloom)`} opacity="0.55" />
        <path
          d="M640 640 L960 640 L1260 900 L340 900 Z"
          fill={`url(#${uid}-spill)`}
          filter={`url(#${uid}-l-blur-md)`}
        />
      </LightLayer>
      <Layer depth={0.2}>
        <SharedDefs uid={uid} />
        <Placed at={[850, 470]} mobile={[724, 470]}>
          <ellipse cx="0" cy="232" rx="60" ry="10" fill="#000" opacity="0.35" />
          <path d="M-46 60 C-50 30 50 30 46 60 L54 170 L-54 170 Z" fill="#1c1a28" />
          <circle cx="0" cy="30" r="36" fill="#1c1a28" />
          <path
            d="M-30 12 C-20 -10 20 -10 30 12"
            stroke="#ffcf8a"
            strokeWidth="3"
            fill="none"
            opacity="0.7"
          />
          <path d="M46 62 L54 170" stroke="#ffcf8a" strokeWidth="3" opacity="0.5" />
          <path d="M-46 62 L-54 170" stroke="#ffcf8a" strokeWidth="3" opacity="0.5" />
          <rect x="-34" y="168" width="24" height="62" rx="8" fill="#15141f" />
          <rect
            x="10"
            y="168"
            width="24"
            height="56"
            rx="8"
            fill="#15141f"
            transform="rotate(-8 22 196)"
          />
        </Placed>
      </Layer>
      <Layer depth={0.5}>
        <SharedDefs uid={uid} />
        <rect x="820" y="756" width="520" height="22" rx="4" fill="#6b4e3a" />
        <rect x="820" y="774" width="520" height="10" fill="#4a3528" />
      </Layer>
      <PetLayer pet={pet} depth={0.5} filter="brightness(0.9) saturate(0.95)" />
      <Layer depth={0.9}>
        <SharedDefs uid={uid} />
        <g filter={`url(#${uid}-blur-xl)`}>
          <rect x="-40" y="600" width="260" height="320" rx="20" fill="#2a2433" />
          <rect x="1380" y="0" width="260" height="900" fill="#1b1826" />
        </g>
      </Layer>
    </>
  );
}
