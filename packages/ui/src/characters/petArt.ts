import type { CharacterId, Expression } from '@ijime/api-types';

/**
 * Felt-plush pet artwork (design sheet 第2稿). Pure functions that return SVG markup, so the
 * same drawing runs in React, server rendering and tests.
 *
 * Construction rules that keep the pets looking natural:
 * - one light for the whole body: body materials share a user-space gradient;
 * - limbs are short tapered nubs drawn behind the body in the same felt layer;
 * - eyes are never shaped by painting over the felt; lids clip the bead instead;
 * - props keep real-world proportion.
 */

export const PET_STATES = ['idle', 'attend', 'listen'] as const;
/** idle: busy with its own thing, turned aside; attend: turned to the child; listen: the child is typing or talking. */
export type PetState = (typeof PET_STATES)[number];

type Attrs = Record<string, string | number | undefined>;
type Shape = [tag: string, attrs: Attrs];
type Pose = [angle: number, dx?: number, dy?: number];

const BLUSH = '#f59aa9';
const THREAD = '#4a3328';
const MOUTH = '#6b3f3f';
const TONGUE = '#f29aa6';
const SHADE = '#3b2a20';
const PROP_KINDS = new Set([
  'nut',
  'cap',
  'shell',
  'leaf',
  'flower',
  'gold',
  'pocket',
  'muzzle',
  'disk',
]);

type EyeKind = 'open' | 'down' | 'up' | 'closed' | 'joy' | 'sleepy' | 'sparkle' | 'gentle';
type MouthKind =
  'omega' | 'smile' | 'flat' | 'smallO' | 'open' | 'big' | 'yawn' | 'soft' | 'closed';

type CharacterArt = {
  colors: Record<string, string>;
  face: {
    lx: number;
    rx: number;
    ey: number;
    my: number;
    er: number;
    ery: number;
    nose?: [number, number];
    lid?: boolean;
    blush?: number;
    beak?: boolean;
  };
  idle: { face: string; eyes: EyeKind; mouth: MouthKind; pose?: string };
  arms?: { kind: string; shoulder: [number, number]; idle?: [Pose, Pose] };
};

export const PET_ART: Record<CharacterId, CharacterArt> = {
  moko: {
    colors: { wool: '#fffaf4', face: '#fbe9ec', ear: '#f2b8c6', hoof: '#e9cfc4' },
    face: { lx: 86, rx: 114, ey: 128, my: 141, er: 5, ery: 6.2 },
    idle: { face: 'translate(-7px,-6px)', eyes: 'up', mouth: 'omega' },
    arms: { kind: 'hoof', shoulder: [44, 150] },
  },
  pokke: {
    colors: {
      fur: '#f6a96b',
      cream: '#fff1e0',
      paw: '#e0894a',
      pocket: '#ffe4c4',
      nut: '#a8693a',
      cap: '#6b4329',
    },
    face: { lx: 80, rx: 120, ey: 120, my: 139, er: 5.6, ery: 7, nose: [100, 132] },
    idle: { face: 'translate(-12px,8px)', eyes: 'down', mouth: 'omega' },
    arms: { kind: 'fur', shoulder: [56, 148] },
  },
  togemaru: {
    colors: {
      spike: '#8a5a3c',
      skin: '#f6d58e',
      paw: '#e7bb68',
      leaf: '#8fbf7a',
      flower: '#f2b8c6',
    },
    face: { lx: 84, rx: 116, ey: 130, my: 147, er: 5, ery: 6.4, nose: [100, 140] },
    idle: { face: 'translate(-10px,7px)', eyes: 'down', mouth: 'smallO' },
    arms: { kind: 'skin', shoulder: [62, 156], idle: [[-20], [-20]] },
  },
  nami: {
    colors: {
      body: '#a9c3dc',
      deep: '#3f6f9c',
      mint: '#d3efe5',
      muzzle: '#f4fbf8',
      shell: '#fde9c8',
    },
    face: {
      lx: 80,
      rx: 120,
      ey: 119,
      my: 143,
      er: 5.5,
      ery: 6.4,
      nose: [100, 131],
      lid: true,
      blush: 0.35,
    },
    idle: { face: 'translate(0px,-2px)', eyes: 'closed', mouth: 'flat' },
    arms: { kind: 'body', shoulder: [58, 148] },
  },
  hoshi: {
    colors: {
      body: '#a3abd6',
      wing: '#3a4570',
      disk: '#fff4dc',
      gold: '#f1c76b',
      belly: '#c7cdeb',
    },
    face: { lx: 80, rx: 120, ey: 113, my: 0, er: 6.5, ery: 8, beak: true },
    idle: { face: 'translate(3px,5px)', eyes: 'sleepy', mouth: 'closed', pose: 'rotate(5deg)' },
  },
  hidden: {
    colors: { shell: '#f6efe2' },
    face: { lx: 86, rx: 114, ey: 134, my: 146, er: 5, ery: 6.4 },
    idle: { face: 'translate(0px,2px)', eyes: 'closed', mouth: 'omega' },
  },
};

const FACE_PLAN: Record<
  Expression,
  { eyes: EyeKind; mouth: MouthKind; blush: number; scale?: number; brows?: boolean }
> = {
  happy: { eyes: 'sparkle', mouth: 'open', blush: 1.3 },
  caring: { eyes: 'open', mouth: 'smile', blush: 0.8, scale: 1.06 },
  sleepy: { eyes: 'sleepy', mouth: 'yawn', blush: 0.5 },
  together: { eyes: 'gentle', mouth: 'smile', blush: 1 },
  celebrate: { eyes: 'joy', mouth: 'big', blush: 1 },
  worried: { eyes: 'open', mouth: 'soft', blush: 0, scale: 1.1, brows: true },
};

// Arms: [angle, dx, dy] for the left nub; 0deg hangs down, positive swings outward. The right one mirrors it.
const ARM_POSE: Record<Expression | 'rest', Pose> = {
  rest: [8],
  happy: [58],
  celebrate: [112, 0, -2],
  caring: [-12],
  worried: [-22],
  together: [38],
  sleepy: [0, 0, 2],
};

const BODY_POSE: Partial<Record<Expression, string>> = {
  happy: 'translateY(-4px)',
  caring: 'translateY(2px) scale(1.03)',
  worried: 'translateY(2px) scale(1.02)',
  together: 'translateY(1px) scale(1.06) rotate(-4deg)',
  sleepy: 'rotate(4deg)',
  celebrate: 'translateY(-10px)',
};

// ---------- markup helpers ----------

function el(tag: string, attrs: Attrs, inner?: string): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
  return inner === undefined ? `<${tag} ${a}/>` : `<${tag} ${a}>${inner}</${tag}>`;
}
const g = (inner: string, attrs: Attrs = {}): string => el('g', attrs, inner);
const S = (tag: string, attrs: Attrs): Shape => [tag, attrs];
const mirror = (d: string): string =>
  d.replace(
    /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g,
    (_m, x: string, y: string) => `${+(200 - Number(x)).toFixed(1)} ${y}`,
  );
const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function mix(a: string, b: string, t: number): string {
  const B = hex(b);
  return (
    '#' +
    hex(a)
      .map((v, i) =>
        Math.round(v + ((B[i] ?? v) - v) * t)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
const thread = (d: string, w = 2.4, color = THREAD): string =>
  el('path', {
    d,
    stroke: color,
    'stroke-width': w,
    fill: 'none',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
const stitch = (d: string, color: string): string =>
  el('path', {
    d,
    fill: 'none',
    stroke: color,
    'stroke-width': 1.3,
    'stroke-dasharray': '3 3',
    'stroke-linecap': 'round',
    opacity: 0.7,
  });
/** A part that moves between the idle pose (--i) and the attending/expression pose (--a). */
function mv(inner: string, { a = '', i = '', o = '100px 184px', cls = '' } = {}): string {
  const style = `transform-origin:${o};${a ? `--a:${a};` : ''}${i ? `--i:${i};` : ''}`;
  return el('g', { class: `pa-mv ${cls}`.trim(), style }, inner);
}

type Ctx = { uid: string; id: CharacterId; clips: number };

const url = (ctx: Ctx, name: string): string => `url(#${ctx.uid}-${name})`;
function paint(ctx: Ctx, kind: string, shapes: Shape[]): string {
  const base = PET_ART[ctx.id].colors[kind] ?? '#cccccc';
  const grad = PROP_KINDS.has(kind) ? `g-${kind}` : `u-${kind}`;
  return shapes
    .map(([t, a]) =>
      el(t, {
        ...a,
        fill: url(ctx, grad),
        stroke: mix(base, SHADE, 0.35),
        'stroke-width': 1.2,
        'stroke-opacity': 0.35,
      }),
    )
    .join('');
}
const seam = (ctx: Ctx, kind: string): string =>
  mix(PET_ART[ctx.id].colors[kind] ?? '#cccccc', SHADE, 0.3);
const felt = (ctx: Ctx, light = false): Attrs => ({ filter: url(ctx, light ? 'felt-l' : 'felt') });

function defs(ctx: Ctx): string {
  const feltFilter = (name: string, grain: string, shadow: number) =>
    el(
      'filter',
      { id: `${ctx.uid}-${name}`, x: '-12%', y: '-12%', width: '124%', height: '130%' },
      el('feTurbulence', {
        type: 'fractalNoise',
        baseFrequency: 0.5,
        numOctaves: 2,
        seed: 3,
        result: 'fine',
      }) +
        el('feDisplacementMap', {
          in: 'SourceGraphic',
          in2: 'fine',
          scale: 3.2,
          xChannelSelector: 'R',
          yChannelSelector: 'G',
          result: 'fuzzy',
        }) +
        el('feTurbulence', {
          type: 'fractalNoise',
          baseFrequency: 1.3,
          numOctaves: 1,
          seed: 11,
          result: 'gn',
        }) +
        el('feColorMatrix', { in: 'gn', type: 'matrix', values: grain, result: 'gc' }) +
        el('feComposite', { in: 'gc', in2: 'fuzzy', operator: 'in', result: 'grain' }) +
        el(
          'feMerge',
          { result: 'm' },
          el('feMergeNode', { in: 'fuzzy' }) + el('feMergeNode', { in: 'grain' }),
        ) +
        el('feDropShadow', {
          in: 'm',
          dx: 0,
          dy: 1.6,
          stdDeviation: 1.4,
          'flood-color': SHADE,
          'flood-opacity': shadow,
        }),
    );
  let s =
    feltFilter('felt', '0 0 0 0 0.25  0 0 0 0 0.18  0 0 0 0 0.14  0.9 0 0 0 -0.32', 0.2) +
    // near-white materials get a lighter grain, otherwise the fibres read as dirt
    feltFilter('felt-l', '0 0 0 0 0.55  0 0 0 0 0.45  0 0 0 0 0.4  0.35 0 0 0 -0.14', 0.16) +
    el('filter', { id: `${ctx.uid}-soft` }, el('feGaussianBlur', { stdDeviation: 2.2 })) +
    el(
      'radialGradient',
      { id: `${ctx.uid}-bead`, cx: 0.35, cy: 0.3, r: 0.75 },
      el('stop', { offset: 0, 'stop-color': '#5a4d44' }) +
        el('stop', { offset: 1, 'stop-color': '#231d19' }),
    );
  for (const [k, base] of Object.entries(PET_ART[ctx.id].colors)) {
    s += el(
      'radialGradient',
      { id: `${ctx.uid}-g-${k}`, cx: 0.38, cy: 0.3, r: 0.85 },
      el('stop', { offset: 0, 'stop-color': mix(base, '#ffffff', 0.4) }) +
        el('stop', { offset: 0.55, 'stop-color': base }) +
        el('stop', { offset: 1, 'stop-color': mix(base, SHADE, 0.16) }),
    );
    // one light for the whole body, so limbs and body read as the same cloth
    s += el(
      'radialGradient',
      {
        id: `${ctx.uid}-u-${k}`,
        gradientUnits: 'userSpaceOnUse',
        cx: 84,
        cy: 96,
        r: 118,
        fx: 80,
        fy: 88,
      },
      el('stop', { offset: 0, 'stop-color': mix(base, '#ffffff', 0.42) }) +
        el('stop', { offset: 0.5, 'stop-color': base }) +
        el('stop', { offset: 1, 'stop-color': mix(base, SHADE, 0.2) }),
    );
  }
  return el('defs', {}, s);
}

// ---------- face ----------

function bead(ctx: Ctx, cx: number, cy: number, rx: number, ry: number): string {
  return (
    el('ellipse', { cx, cy, rx, ry, fill: url(ctx, 'bead') }) +
    el('circle', {
      cx: (cx + rx * 0.32).toFixed(1),
      cy: (cy - ry * 0.4).toFixed(1),
      r: (rx * 0.44).toFixed(2),
      fill: '#fff',
    }) +
    el('circle', {
      cx: (cx - rx * 0.34).toFixed(1),
      cy: (cy + ry * 0.38).toFixed(1),
      r: (rx * 0.2).toFixed(2),
      fill: '#fff',
      opacity: 0.85,
    })
  );
}
/** A lidded eye: the bead is clipped below the lid line, then the lid is stitched on. */
function lidded(
  ctx: Ctx,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  at: number,
  sag = 0.35,
): string {
  const id = `${ctx.uid}-lid${++ctx.clips}`;
  const curve = `M${cx - rx - 2} ${at + 1} Q${cx} ${at - ry * sag} ${cx + rx + 2} ${at + 1}`;
  return (
    el(
      'clipPath',
      { id },
      el('path', { d: `${curve} L${cx + rx + 2} ${cy + ry + 3} L${cx - rx - 2} ${cy + ry + 3} Z` }),
    ) +
    g(bead(ctx, cx, cy, rx, ry), { 'clip-path': `url(#${id})` }) +
    thread(`M${cx - rx - 1} ${at + 1} Q${cx} ${at - ry * sag} ${cx + rx + 1} ${at + 1}`, 2.1)
  );
}
function eyePair(ctx: Ctx, kind: EyeKind, scale = 1): string {
  const f = PET_ART[ctx.id].face;
  const one = (cx: number): string => {
    const rx = f.er * scale;
    const ry = f.ery * scale;
    const cy = f.ey;
    switch (kind) {
      case 'open':
        return g(f.lid ? lidded(ctx, cx, cy, rx, ry, cy - ry * 0.3) : bead(ctx, cx, cy, rx, ry), {
          class: 'pa-blink',
        });
      case 'sparkle': {
        // wide, shining eyes; even the cool one opens its eyes when it is happy
        const R = rx * 1.12,
          Ry = ry * 1.1,
          sx = cx - R * 0.3,
          sy = cy + Ry * 0.1,
          k = R * 0.38;
        return g(
          bead(ctx, cx, cy - 0.5, R, Ry) +
            el('path', {
              d: `M${sx} ${sy - k} Q${sx} ${sy} ${sx + k} ${sy} Q${sx} ${sy} ${sx} ${sy + k} Q${sx} ${sy} ${sx - k} ${sy} Q${sx} ${sy} ${sx} ${sy - k} Z`,
              fill: '#fff',
              opacity: 0.9,
            }),
          { class: 'pa-blink' },
        );
      }
      // looking down at something: the bead just drops a little; a lid here reads as sulking
      case 'down':
        return g(bead(ctx, cx, cy + 2.5, rx * 0.95, ry * 0.9), { class: 'pa-blink' });
      case 'up':
        return g(bead(ctx, cx, cy - 2, rx, ry), { class: 'pa-blink' });
      case 'gentle':
        return thread(`M${cx - 6} ${cy + 2} Q${cx} ${cy - 3.5} ${cx + 6} ${cy + 2}`, 2.5);
      case 'closed':
        return thread(`M${cx - 6} ${cy + 1} Q${cx} ${cy + 4} ${cx + 6} ${cy + 1}`, 2.6);
      case 'joy':
        return thread(`M${cx - 6.5} ${cy + 3} Q${cx} ${cy - 7} ${cx + 6.5} ${cy + 3}`, 3);
      case 'sleepy':
        return lidded(ctx, cx, cy + 1, rx, ry * 0.9, cy + 1 + ry * 0.12, -0.25);
    }
  };
  return one(f.lx) + one(f.rx);
}
function mouthArt(kind: MouthKind, x: number, y: number): string {
  switch (kind) {
    case 'omega':
      return thread(`M${x - 6} ${y} q3 4 6 0 q3 4 6 0`, 2.3);
    case 'smile':
      return thread(`M${x - 5} ${y} q5 4.5 10 0`, 2.3);
    case 'flat':
      return thread(`M${x - 4} ${y + 1} L${x + 4} ${y + 1}`, 2.2);
    case 'smallO':
      return el('ellipse', { cx: x, cy: y + 1, rx: 2.2, ry: 2.6, fill: MOUTH });
    case 'open':
      return (
        el('path', {
          d: `M${x - 6.5} ${y - 1} Q${x} ${y + 11} ${x + 6.5} ${y - 1} Z`,
          fill: MOUTH,
        }) + el('ellipse', { cx: x, cy: y + 3.4, rx: 3, ry: 1.7, fill: TONGUE })
      );
    case 'big':
      return (
        el('path', {
          d: `M${x - 8.5} ${y - 2} Q${x} ${y + 15} ${x + 8.5} ${y - 2} Z`,
          fill: MOUTH,
        }) + el('ellipse', { cx: x, cy: y + 5, rx: 4, ry: 2.3, fill: TONGUE })
      );
    case 'yawn':
      return el('ellipse', { cx: x, cy: y + 2, rx: 3.6, ry: 4.6, fill: MOUTH });
    case 'soft':
      return thread(`M${x - 5} ${y + 1} Q${x} ${y - 1.2} ${x + 5} ${y + 1}`, 2.3);
    case 'closed':
      return '';
  }
}
function beakArt(ctx: Ctx, kind: MouthKind, x: number, y: number): string {
  if (kind === 'open' || kind === 'big' || kind === 'yawn') {
    return (
      paint(ctx, 'gold', [
        S('path', {
          d: `M${x - 6} ${y - 3} Q${x} ${y - 7} ${x + 6} ${y - 3} Q${x} ${y + 1} ${x - 6} ${y - 3} Z`,
        }),
      ]) +
      el('path', {
        d: `M${x - 4.5} ${y + 1} Q${x} ${y + (kind === 'big' ? 9 : 7)} ${x + 4.5} ${y + 1} Z`,
        fill: MOUTH,
      })
    );
  }
  return paint(ctx, 'gold', [
    S('path', {
      d: `M${x - 6} ${y - 3} Q${x} ${y - 7} ${x + 6} ${y - 3} Q${x + 1} ${y + 6} ${x} ${y + 6} Q${x - 1} ${y + 6} ${x - 6} ${y - 3} Z`,
    }),
  ]);
}
function mouthOf(ctx: Ctx, kind: MouthKind): string {
  const f = PET_ART[ctx.id].face;
  return f.beak ? beakArt(ctx, kind, 100, f.ey + 15) : mouthArt(kind, 100, f.my);
}

function faceGroup(ctx: Ctx, expr: Expression, patch: string): string {
  const c = PET_ART[ctx.id];
  const f = c.face;
  const p = FACE_PLAN[expr];
  const bo = Math.min(1, (f.blush ?? 0.6) * Math.max(p.blush, 0.5)).toFixed(2);
  const by = f.ey + f.ery + 5;
  let s = patch;
  s += el('ellipse', {
    cx: f.lx - 10,
    cy: by,
    rx: 8,
    ry: 4.6,
    fill: BLUSH,
    opacity: bo,
    filter: url(ctx, 'soft'),
  });
  s += el('ellipse', {
    cx: f.rx + 10,
    cy: by,
    rx: 8,
    ry: 4.6,
    fill: BLUSH,
    opacity: bo,
    filter: url(ctx, 'soft'),
  });
  s += g(eyePair(ctx, c.idle.eyes), { class: 'pa-eI' });
  let brows = '';
  if (p.brows) {
    // inner ends lifted a little: concern for the child, not fear
    const b = f.ey - f.ery * 1.1 - 7;
    brows =
      thread(`M${f.lx - 7} ${b + 2} Q${f.lx - 1} ${b} ${f.lx + 5} ${b - 3}`, 2.2) +
      thread(`M${f.rx + 7} ${b + 2} Q${f.rx + 1} ${b} ${f.rx - 5} ${b - 3}`, 2.2);
  }
  s += g(eyePair(ctx, p.eyes, p.scale ?? 1) + brows, { class: 'pa-eA' });
  s += g(eyePair(ctx, 'joy'), { class: 'pa-eJ' });
  if (f.nose) {
    s += el('ellipse', { cx: f.nose[0], cy: f.nose[1], rx: 4.3, ry: 3.3, fill: url(ctx, 'bead') });
    s += el('ellipse', {
      cx: f.nose[0] - 1.2,
      cy: f.nose[1] - 1.2,
      rx: 1.3,
      ry: 0.8,
      fill: '#fff',
      opacity: 0.7,
    });
  }
  s += g(mouthOf(ctx, c.idle.mouth), { class: 'pa-mI' });
  s += g(mouthOf(ctx, p.mouth), { class: 'pa-mA' });
  s += g(mouthOf(ctx, 'open'), { class: 'pa-mJ' });
  return s;
}

// ---------- arms: short tapered nubs that grow from behind the body ----------

function armPath(x: number, y: number): string {
  return `M${x - 9} ${y - 8} L${x + 9} ${y - 8} C${x + 10.5} ${y + 4} ${x + 10.5} ${y + 13} ${x + 8.5} ${y + 18} C${x + 6.5} ${y + 24.5} ${x - 6.5} ${y + 24.5} ${x - 8.5} ${y + 18} C${x - 10.5} ${y + 13} ${x - 10.5} ${y + 4} ${x - 9} ${y - 8} Z`;
}
function arms(ctx: Ctx, expr: Expression): string {
  const a = PET_ART[ctx.id].arms;
  if (!a) return '';
  const target = ARM_POSE[expr];
  const idle = a.idle ?? [ARM_POSE.rest, ARM_POSE.rest];
  const [sx, sy] = a.shoulder;
  const side = (i: 0 | 1): string => {
    const x = i ? 200 - sx : sx;
    const m = i ? -1 : 1;
    const tf = ([t, dx = 0, dy = 0]: Pose) => `translate(${m * dx}px,${dy}px) rotate(${m * t}deg)`;
    return mv(paint(ctx, a.kind, [S('path', { d: armPath(x, sy) })]), {
      a: tf(target),
      i: tf(idle[i]),
      o: `${x}px ${sy}px`,
    });
  };
  return side(0) + side(1);
}

// ---------- bodies ----------

type Parts = { back: string; patch: string; front: string };
const ARMS = '%%ARMS%%';
const feet = (ctx: Ctx, kind: string, xs: [number, number], rx = 11, ry = 6.5): string =>
  paint(
    ctx,
    kind,
    xs.map((cx) => S('ellipse', { cx, cy: 182, rx, ry })),
  );

function moko(ctx: Ctx, expr: Expression): Parts {
  const puffs = [
    [58, 112, 22],
    [76, 90, 24],
    [100, 84, 24],
    [124, 90, 24],
    [142, 112, 22],
    [150, 138, 21],
    [50, 138, 21],
    [60, 162, 20],
    [140, 162, 20],
    [82, 172, 20],
    [118, 172, 20],
    [100, 132, 50],
  ] as const;
  const tuft: Partial<Record<Expression, string>> = {
    celebrate: 'translate(100 80) scale(1.18) translate(-100 -80)',
    sleepy: 'translate(0 8) translate(100 80) scale(1 .62) translate(-100 -80)',
    together: 'rotate(-8 100 84)',
  };
  const curl = (x: number, y: number) =>
    thread(`M${x - 6} ${y} q3 -5 6 -1 q3 -4 6 1`, 1.6, '#e8d6ca');
  const back =
    feet(ctx, 'hoof', [84, 116]) +
    ARMS +
    paint(
      ctx,
      'wool',
      puffs.map(([cx, cy, r]) => S('circle', { cx, cy, r })),
    ) +
    [
      [66, 152],
      [134, 152],
      [100, 168],
      [70, 100],
      [130, 100],
    ]
      .map(([x, y]) => curl(x!, y!))
      .join('') +
    g(
      el(
        'g',
        { transform: tuft[expr] ?? '' },
        paint(ctx, 'wool', [
          S('circle', { cx: 86, cy: 72, r: 13 }),
          S('circle', { cx: 100, cy: 63, r: 15 }),
          S('circle', { cx: 114, cy: 72, r: 13 }),
        ]) + thread('M92 66 q4 -4 8 0 q4 -4 8 0', 1.6, '#e8d6ca'),
      ),
      { class: 'pa-tuftw' },
    ) +
    paint(ctx, 'ear', [
      S('ellipse', { cx: 58, cy: 120, rx: 14, ry: 8, transform: 'rotate(28 58 120)' }),
      S('ellipse', { cx: 142, cy: 120, rx: 14, ry: 8, transform: 'rotate(-28 142 120)' }),
    ]);
  const patch = g(
    paint(ctx, 'face', [S('ellipse', { cx: 100, cy: 132, rx: 35, ry: 29 })]) +
      stitch('M70 128 Q72 108 100 105 Q128 108 130 128', seam(ctx, 'face')),
    felt(ctx),
  );
  // idle: a little cloud drifting by, which it watches
  const cloud = g(
    g(
      paint(ctx, 'wool', [
        S('circle', { cx: 30, cy: 46, r: 9 }),
        S('circle', { cx: 40, cy: 40, r: 11 }),
        S('circle', { cx: 51, cy: 46, r: 8 }),
        S('ellipse', { cx: 40, cy: 49, rx: 18, ry: 6 }),
      ]),
      { class: 'pa-cloudlet', ...felt(ctx, true) },
    ),
    { class: 'pa-propI' },
  );
  return { back: g(back, felt(ctx, true)), patch, front: cloud };
}

function pokke(ctx: Ctx): Parts {
  const TAIL =
    'M118 170 C166 178 196 134 182 96 C176 78 158 72 150 84 C142 96 158 108 158 128 C158 146 140 156 116 154 Z';
  const TIP =
    'M150 84 C158 72 176 78 182 96 C185 106 184 114 181 121 C173 112 162 104 154 100 C149 96 147 90 150 84 Z';
  const EAR = 'M54 104 C46 74 50 50 62 47 C74 44 90 62 100 82 Z';
  const EAR_IN = 'M63 92 C59 74 61 61 67 60 C73 59 82 70 88 80 Z';
  const sc = seam(ctx, 'cream');
  const cream = url(ctx, 'g-cream');
  const tail = g(
    paint(ctx, 'fur', [S('path', { d: TAIL })]) +
      el('path', { d: TIP, fill: cream }) +
      stitch('M152 88 C160 96 170 104 180 116', sc),
    { class: 'pa-tailw' },
  );
  const ears = g(
    paint(ctx, 'fur', [S('path', { d: EAR }), S('path', { d: mirror(EAR) })]) +
      el('path', { d: EAR_IN, fill: cream }) +
      el('path', { d: mirror(EAR_IN), fill: cream }) +
      stitch('M64 90 C60 75 62 63 67 62', sc) +
      stitch(mirror('M64 90 C60 75 62 63 67 62'), sc),
    { class: 'pa-earsw' },
  );
  const back =
    tail +
    feet(ctx, 'paw', [84, 116]) +
    mv(ears, { i: 'translate(-6px,2px) rotate(-4deg)', o: '100px 96px' }) +
    ARMS +
    paint(ctx, 'fur', [S('ellipse', { cx: 100, cy: 130, rx: 58, ry: 54 })]);
  const patch = g(
    el('path', {
      d: 'M60 128 Q68 154 100 154 Q132 154 140 128 Q128 138 116 134 Q108 124 100 124 Q92 124 84 134 Q72 138 60 128 Z',
      fill: cream,
    }) + stitch('M64 133 Q72 150 100 150 Q128 150 136 133', sc),
    felt(ctx),
  );
  // pocket sits in front of the muzzle: a dark opening, the acorn tucked in (only its cap peeks out), then the front flap
  const pocket = g(
    el('path', { d: 'M84 160 Q100 154 116 160 Q100 166 84 160 Z', fill: '#c9864d' }) +
      g(
        el(
          'g',
          { transform: 'rotate(14 108 156)' },
          paint(ctx, 'nut', [S('ellipse', { cx: 108, cy: 159, rx: 4.4, ry: 5.4 })]) +
            el('ellipse', { cx: 106.6, cy: 157, rx: 1.3, ry: 2, fill: '#fff', opacity: 0.3 }) +
            paint(ctx, 'cap', [
              S('path', {
                d: 'M102.3 155.5 Q102 150.5 108 150.2 Q114 150.5 113.7 155.5 Q108 157.2 102.3 155.5 Z',
              }),
            ]) +
            thread('M104 153 L112 153', 0.8, '#5a3722') +
            thread('M108 150.2 q.4 -2.4 2 -3', 1.4, '#6b4329'),
        ),
        { class: 'pa-propA' },
      ) +
      paint(ctx, 'pocket', [
        S('path', {
          d: 'M84 160 Q100 166 116 160 C117 166 116 172 114 175 Q100 182 86 175 C84 172 83 166 84 160 Z',
        }),
      ]) +
      stitch('M86 162.5 Q100 168 114 162.5', seam(ctx, 'pocket')),
    { ...felt(ctx), transform: 'translate(0 3)' },
  );
  // idle: the acorn lies by its feet and it looks down at it
  const cx = 46,
    cy = 174;
  const ground = g(
    g(
      paint(ctx, 'nut', [S('ellipse', { cx, cy: cy + 2, rx: 6, ry: 7.5 })]) +
        paint(ctx, 'cap', [
          S('path', { d: `M${cx - 7.5} ${cy - 1} Q${cx} ${cy - 10} ${cx + 7.5} ${cy - 1} Z` }),
        ]) +
        thread(`M${cx} ${cy - 7} q1 -3 3 -4`, 1.8, '#6b4329'),
      felt(ctx),
    ),
    { class: 'pa-propI' },
  );
  return { back: g(back, felt(ctx)), patch, front: pocket + ground };
}

function togemaru(ctx: Ctx): Parts {
  const tufts: Shape[] = [];
  for (let i = 0; i <= 12; i++) {
    const th = ((-22 + (224 / 12) * i) * Math.PI) / 180;
    const x = (100 + Math.cos(th) * 50).toFixed(1),
      y = (128 - Math.sin(th) * 50).toFixed(1);
    tufts.push(
      S('ellipse', {
        cx: x,
        cy: y,
        rx: 12,
        ry: 22,
        transform: `rotate(${(90 - (th * 180) / Math.PI).toFixed(1)} ${x} ${y})`,
      }),
    );
  }
  tufts.push(S('ellipse', { cx: 100, cy: 130, rx: 56, ry: 50 }));
  const highlights = [
    [-10, 54],
    [40, 52],
    [90, 54],
    [140, 52],
    [190, 54],
  ]
    .map(([deg, R]) => {
      const th = (deg! * Math.PI) / 180,
        x = (100 + Math.cos(th) * R!).toFixed(1),
        y = (128 - Math.sin(th) * R!).toFixed(1);
      return el('ellipse', {
        cx: x,
        cy: y,
        rx: 3,
        ry: 8,
        fill: '#b08360',
        opacity: 0.7,
        transform: `rotate(${90 - deg!} ${x} ${y})`,
      });
    })
    .join('');
  // the leaf that is always stuck on its back
  const spikes = mv(
    g(
      paint(ctx, 'spike', tufts) +
        highlights +
        paint(ctx, 'leaf', [S('path', { d: 'M132 66 Q150 52 160 64 Q148 80 132 66 Z' })]) +
        thread('M136 67 Q148 64 156 63', 1.5, '#5f9150'),
      { class: 'pa-spk' },
    ),
    { i: 'scale(1.08)', o: '100px 130px' },
  );
  const back =
    feet(ctx, 'paw', [86, 114]) +
    spikes +
    paint(ctx, 'skin', [
      S('circle', { cx: 72, cy: 98, r: 9 }),
      S('circle', { cx: 128, cy: 98, r: 9 }),
    ]) +
    ARMS +
    paint(ctx, 'skin', [
      S('path', {
        d: 'M52 140 C52 108 74 98 100 98 C126 98 148 108 148 140 C148 168 128 182 100 182 C72 182 52 168 52 140 Z',
      }),
    ]) +
    stitch('M60 150 Q62 112 100 106 Q138 112 140 150', seam(ctx, 'skin'));
  const petals = [0, 72, 144, 216, 288].map((a) => {
    const r = (a * Math.PI) / 180;
    return S('circle', {
      cx: (36 + Math.cos(r) * 5).toFixed(1),
      cy: (160 + Math.sin(r) * 5).toFixed(1),
      r: 4,
    });
  });
  const flower = g(
    g(
      paint(ctx, 'leaf', [
        S('ellipse', { cx: 30, cy: 178, rx: 7, ry: 3.5, transform: 'rotate(-20 30 178)' }),
      ]) +
        thread('M34 182 Q36 172 36 164', 2, '#5f9150') +
        paint(ctx, 'flower', petals),
      felt(ctx),
    ) + el('circle', { cx: 36, cy: 160, r: 2.6, fill: '#f3c96b' }),
    { class: 'pa-propI' },
  );
  return { back: g(back, felt(ctx)), patch: '', front: flower };
}

function nami(ctx: Ctx): Parts {
  const back =
    paint(ctx, 'deep', [
      S('path', { d: 'M140 170 C160 176 176 168 180 156 C170 154 156 158 140 160 Z' }),
    ]) +
    feet(ctx, 'deep', [84, 116]) +
    paint(ctx, 'deep', [
      S('circle', { cx: 56, cy: 98, r: 10 }),
      S('circle', { cx: 144, cy: 98, r: 10 }),
    ]) +
    ARMS +
    paint(ctx, 'body', [
      S('path', {
        d: 'M46 136 C46 96 70 76 100 76 C130 76 154 96 154 136 C154 166 132 184 100 184 C68 184 46 166 46 136 Z',
      }),
    ]) +
    el('ellipse', { cx: 100, cy: 160, rx: 34, ry: 21, fill: url(ctx, 'g-mint') }) +
    stitch('M68 156 Q100 136 132 156', seam(ctx, 'mint'));
  const patch =
    g(
      paint(ctx, 'muzzle', [
        S('circle', { cx: 91, cy: 137, r: 11 }),
        S('circle', { cx: 109, cy: 137, r: 11 }),
      ]),
      felt(ctx),
    ) +
    [
      [86, 136],
      [84, 141],
      [114, 136],
      [116, 141],
    ]
      .map(([x, y]) => el('circle', { cx: x, cy: y, r: 1.1, fill: '#8aa6bf' }))
      .join('');
  // its favourite scallop: on the belly while it listens, balanced on its head while it plays
  const shell = (cx: number, cy: number): string => {
    const fan = `M${cx - 13} ${cy + 3} C${cx - 15} ${cy - 6} ${cx - 8} ${cy - 12} ${cx} ${cy - 12} C${cx + 8} ${cy - 12} ${cx + 15} ${cy - 6} ${cx + 13} ${cy + 3} Q${cx} ${cy + 7} ${cx - 13} ${cy + 3} Z`;
    const hinge = `M${cx - 6} ${cy + 3} L${cx + 6} ${cy + 3} L${cx + 4} ${cy + 9} L${cx - 4} ${cy + 9} Z`;
    const ridges = [-0.72, -0.36, 0, 0.36, 0.72]
      .map((t) =>
        thread(
          `M${(cx + t * 3).toFixed(1)} ${cy + 4} L${(cx + t * 12.5).toFixed(1)} ${(cy - 11 + 7 * t * t).toFixed(1)}`,
          1.3,
          '#e9a08a',
        ),
      )
      .join('');
    return (
      paint(ctx, 'shell', [S('path', { d: hinge }), S('path', { d: fan })]) +
      ridges +
      el('ellipse', { cx: cx - 4, cy: cy - 7, rx: 3.5, ry: 1.6, fill: '#ffffff', opacity: 0.5 })
    );
  };
  const front =
    g(g(shell(100, 162), felt(ctx)), { class: 'pa-propA' }) +
    g(g(shell(100, 70), felt(ctx)), { class: 'pa-propI' });
  return { back: g(back, felt(ctx)), patch, front };
}

function hoshi(ctx: Ctx, expr: Expression): Parts {
  const tuft = 'M58 92 C50 72 54 56 64 56 C74 56 82 70 86 84 Z';
  // wings sit behind the body like the paws do: only the outer edge shows, and they open from there
  const ang: Record<Expression, [number, number]> = {
    happy: [34, -34],
    celebrate: [62, -62],
    caring: [-6, 6],
    worried: [-10, 10],
    together: [24, -24],
    sleepy: [-2, 2],
  };
  const [la, ra] = ang[expr];
  const wL = 'M48 106 C28 126 28 162 50 176 C58 152 58 126 54 106 Z';
  const wing = (d: string, feather: string) =>
    paint(ctx, 'wing', [S('path', { d })]) + thread(feather, 1.5, '#5b6699');
  const wings =
    mv(wing(wL, 'M36 140 q4 6 8 4 M36 154 q4 6 8 4'), {
      a: `rotate(${la}deg)`,
      i: 'rotate(-3deg)',
      o: '52px 110px',
    }) +
    mv(wing(mirror(wL), 'M164 140 q-4 6 -8 4 M164 154 q-4 6 -8 4'), {
      a: `rotate(${ra}deg)`,
      i: 'rotate(3deg)',
      o: '148px 110px',
    });
  const back =
    paint(ctx, 'gold', [
      S('ellipse', { cx: 88, cy: 182, rx: 7, ry: 5 }),
      S('ellipse', { cx: 112, cy: 182, rx: 7, ry: 5 }),
    ]) +
    wings +
    paint(ctx, 'body', [
      S('path', { d: tuft }),
      S('path', { d: mirror(tuft) }),
      S('path', {
        d: 'M44 128 C44 88 68 64 100 64 C132 64 156 88 156 128 C156 162 132 184 100 184 C68 184 44 162 44 128 Z',
      }),
    ]) +
    el('ellipse', { cx: 100, cy: 160, rx: 30, ry: 20, fill: url(ctx, 'g-belly') }) +
    [
      [90, 156],
      [110, 156],
      [100, 166],
    ]
      .map(([x, y]) => thread(`M${x! - 5} ${y} q5 4 10 0`, 1.8, '#9aa2cf'))
      .join('');
  const pts = Array.from({ length: 10 }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / 5,
      r = i % 2 ? 3.6 : 8;
    return `${(100 + Math.cos(a) * r).toFixed(1)} ${(147 + Math.sin(a) * r).toFixed(1)}`;
  }).join(' L');
  // the chest star dims while it dozes in the daytime
  const star = mv(
    el('path', {
      d: `M${pts} Z`,
      fill: url(ctx, 'g-gold'),
      stroke: '#d9a93e',
      'stroke-width': 1.3,
      'stroke-linejoin': 'round',
    }) +
      el('circle', {
        cx: 100,
        cy: 147,
        r: 13,
        fill: '#f1c76b',
        opacity: 0.25,
        filter: url(ctx, 'soft'),
      }),
    { i: 'scale(.85)', o: '100px 147px', cls: 'pa-starw' },
  );
  const patch =
    g(
      paint(ctx, 'disk', [
        S('circle', { cx: 80, cy: 113, r: 22 }),
        S('circle', { cx: 120, cy: 113, r: 22 }),
      ]),
      felt(ctx),
    ) +
    el('circle', { cx: 80, cy: 113, r: 13, fill: 'none', stroke: '#f1c76b', 'stroke-width': 2.4 }) +
    el('circle', { cx: 120, cy: 113, r: 13, fill: 'none', stroke: '#f1c76b', 'stroke-width': 2.4 });
  const doze = g(
    g('<text x="146" y="66" font-size="14">z</text><text x="158" y="52" font-size="10">z</text>', {
      class: 'pa-zzz',
      fill: '#6b9ac4',
      'font-weight': 700,
    }),
    { class: 'pa-propI' },
  );
  return { back: g(back, felt(ctx)) + star, patch, front: doze };
}

function hidden(ctx: Ctx): Parts {
  const dots = [
    [70, 92, 6, '#c9b8d9'],
    [128, 80, 4.5, '#9fd9c8'],
    [138, 120, 6.5, '#f2b8c6'],
    [62, 150, 5, '#9fd9c8'],
    [134, 160, 4, '#c9b8d9'],
    [104, 70, 3.5, '#f3c96b'],
    [74, 120, 3, '#f3c96b'],
  ] as const;
  const back =
    g(
      paint(ctx, 'shell', [
        S('path', {
          d: 'M100 54 C66 54 48 104 48 138 C48 166 70 184 100 184 C130 184 152 166 152 138 C152 104 134 54 100 54 Z',
        }),
      ]) +
        dots.map(([cx, cy, r, fill]) => el('circle', { cx, cy, r, fill, opacity: 0.9 })).join(''),
      felt(ctx, true),
    ) +
    thread(
      'M64 106 L74 98 L82 106 L92 96 L100 104 L110 95 L118 104 L128 97 L136 104',
      2.2,
      '#b8a68a',
    );
  return { back, patch: '', front: '' };
}

function fx(expr: Expression): string {
  if (expr === 'celebrate') {
    return g(
      el('path', {
        class: 'pa-twinkle',
        d: 'M28 64 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 l10 -4 z',
      }) +
        el('path', {
          class: 'pa-twinkle pa-b',
          d: 'M170 44 l3 8 l8 3 l-8 3 l-3 8 l-3 -8 l-8 -3 l8 -3 z',
        }) +
        el('circle', { class: 'pa-twinkle pa-b', cx: 166, cy: 100, r: 3.5 }) +
        el('circle', { class: 'pa-twinkle', cx: 40, cy: 34, r: 3 }),
      { fill: '#f4c95d', class: 'pa-eA' },
    );
  }
  if (expr === 'sleepy') {
    return g(
      '<text x="150" y="70" font-size="18">z</text><text x="164" y="52" font-size="14">z</text><text x="176" y="40" font-size="10">z</text>',
      { class: 'pa-zzz pa-eA', fill: '#6b9ac4', 'font-weight': 700 },
    );
  }
  return '';
}

/**
 * Inner markup of a pet SVG (viewBox 0 0 200 200). State and tap reactions are classes on the
 * outer <svg>, so switching them keeps this markup and lets CSS transitions run.
 * `uid` must be unique per rendered SVG; `lite` drops the felt filters for small sizes.
 */
export function renderPetArt(
  id: CharacterId,
  expr: Expression,
  { uid, lite = false }: { uid: string; lite?: boolean },
): string {
  const ctx: Ctx = { uid, id, clips: 0 };
  const parts =
    id === 'moko'
      ? moko(ctx, expr)
      : id === 'pokke'
        ? pokke(ctx)
        : id === 'togemaru'
          ? togemaru(ctx)
          : id === 'nami'
            ? nami(ctx)
            : id === 'hoshi'
              ? hoshi(ctx, expr)
              : hidden(ctx);
  const back = parts.back.replace(ARMS, arms(ctx, expr));
  const c = PET_ART[id];
  let pose = BODY_POSE[expr] ?? '';
  // もこ's quirk: it floats when it is happy
  if (id === 'moko' && expr === 'happy') pose = 'translateY(-10px)';
  if (id === 'moko' && expr === 'celebrate') pose = 'translateY(-18px)';
  const floating = id === 'moko' && (expr === 'happy' || expr === 'celebrate');
  const face = mv(faceGroup(ctx, expr, parts.patch), { i: c.idle.face, o: '100px 120px' });
  const content = mv(back + face + parts.front, { a: pose, i: c.idle.pose ?? '' });
  const body = g(
    g(g(g(content, { class: 'pa-breathe' }), { class: 'pa-expr' }), { class: 'pa-tap' }),
    { class: 'pa-listen' },
  );
  const shadow = mv(
    el('ellipse', {
      cx: 100,
      cy: 189,
      rx: 54,
      ry: 6,
      fill: SHADE,
      opacity: 0.14,
      filter: url(ctx, 'soft'),
    }),
    { a: floating ? 'scale(.78)' : '', o: '100px 189px', cls: 'pa-shadow' },
  );
  let markup = defs(ctx) + shadow + body + fx(expr);
  if (lite)
    markup = markup
      .replaceAll(` filter="${url(ctx, 'felt')}"`, '')
      .replaceAll(` filter="${url(ctx, 'felt-l')}"`, '');
  return markup;
}

/** Shared stylesheet for every pet SVG. Each layer animates a different wrapper so transforms never fight. */
export const PET_CSS = `
.pa-pet g{transform-box:view-box}
.pa-pet .pa-mv{transform:var(--a,none);transition:transform .7s cubic-bezier(.3,1.2,.5,1),opacity .4s ease}
.pa-pet.pa-idle .pa-mv{transform:var(--i,var(--a,none))}
.pa-pet .pa-propI,.pa-pet .pa-eI,.pa-pet .pa-mI{opacity:0;transition:opacity .35s ease}
.pa-pet .pa-propA,.pa-pet .pa-eA,.pa-pet .pa-mA{transition:opacity .35s ease .25s}
.pa-pet.pa-idle .pa-propI,.pa-pet.pa-idle .pa-eI,.pa-pet.pa-idle .pa-mI{opacity:1;transition-delay:.2s}
.pa-pet.pa-idle .pa-propA,.pa-pet.pa-idle .pa-eA,.pa-pet.pa-idle .pa-mA{opacity:0;transition-delay:0s}
.pa-pet .pa-eJ,.pa-pet .pa-mJ{opacity:0}
.pa-pet.pa-joy .pa-eJ,.pa-pet.pa-joy .pa-mJ{opacity:1;transition:none}
.pa-pet.pa-joy .pa-eA,.pa-pet.pa-joy .pa-mA,.pa-pet.pa-joy .pa-eI,.pa-pet.pa-joy .pa-mI{opacity:0;transition:none}
.pa-pet .pa-zzz{font-family:'Zen Maru Gothic',system-ui,sans-serif}
.pa-anim .pa-breathe{animation:pa-breathe 10s ease-in-out infinite;transform-origin:100px 184px}
.pa-anim .pa-blink{animation:pa-blink 5.4s infinite;transform-box:fill-box;transform-origin:center}
.pa-anim .pa-twinkle{animation:pa-twinkle 2.2s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
.pa-anim .pa-twinkle.pa-b{animation-delay:.7s}
.pa-anim .pa-zzz{animation:pa-floatup 3s ease-in-out infinite}
.pa-anim .pa-tailw{animation:pa-sway 6s ease-in-out infinite;transform-origin:122px 162px}
.pa-anim:not(.pa-idle) .pa-tailw{animation:pa-wag 1.6s ease-in-out infinite}
.pa-anim .pa-cloudlet{animation:pa-drift 6s ease-in-out infinite}
.pa-anim.pa-idle.pa-c-hidden .pa-listen{animation:pa-rock 4s ease-in-out infinite;transform-origin:100px 184px}
.pa-anim.pa-e-happy:not(.pa-idle) .pa-expr{animation:pa-hop 1.8s ease-in-out infinite;transform-origin:100px 184px}
.pa-anim.pa-e-celebrate:not(.pa-idle) .pa-expr{animation:pa-jump 1.2s ease-in-out infinite;transform-origin:100px 184px}
.pa-anim.pa-e-together:not(.pa-idle) .pa-expr{animation:pa-nestle 5s ease-in-out infinite;transform-origin:100px 184px}
.pa-listening.pa-c-moko .pa-listen{animation:pa-moko-tilt 3.6s ease-in-out infinite;transform-origin:100px 184px}
.pa-listening.pa-c-moko .pa-tuftw{animation:pa-tuft-lean 3.6s ease-in-out infinite;transform-origin:100px 84px}
.pa-listening.pa-c-pokke .pa-listen{animation:pa-lean 2.4s ease-in-out infinite;transform-origin:100px 184px}
.pa-listening.pa-c-pokke .pa-earsw{animation:pa-perk 2.4s ease-in-out infinite;transform-origin:100px 96px}
.pa-listening.pa-c-pokke .pa-tailw{animation:pa-wag 1s ease-in-out infinite}
.pa-listening.pa-c-togemaru .pa-listen{animation:pa-peek 4s ease-in-out infinite;transform-origin:100px 184px}
.pa-listening.pa-c-togemaru .pa-spk{animation:pa-relax 4s ease-in-out infinite;transform-origin:100px 130px}
.pa-listening.pa-c-nami .pa-listen{animation:pa-nod 2.8s ease-in-out infinite;transform-origin:100px 184px}
.pa-listening.pa-c-hoshi .pa-listen{animation:pa-owl-tilt 5s ease-in-out infinite;transform-origin:100px 160px}
.pa-listening.pa-c-hidden .pa-listen{animation:pa-wobble 1.4s ease-in-out infinite;transform-origin:100px 184px}
.pa-tapped .pa-tap{animation:pa-squish .6s cubic-bezier(.3,1.6,.5,1);transform-origin:100px 186px}
.pa-tapped.pa-c-moko .pa-tap{animation:pa-squish-deep .8s cubic-bezier(.3,1.6,.5,1)}
.pa-tapped.pa-c-togemaru .pa-spk{animation:pa-puff .8s ease-out;transform-origin:100px 130px}
.pa-tapped.pa-c-pokke .pa-tailw{animation:pa-swirl .7s ease-in-out}
.pa-tapped.pa-c-hoshi .pa-tap{animation:pa-fluff .8s ease-out}
.pa-tapped.pa-c-hidden .pa-tap{animation:pa-hop-egg .6s ease-out}
@keyframes pa-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.012,1.028)}}
@keyframes pa-blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}
@keyframes pa-twinkle{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.1)}}
@keyframes pa-floatup{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes pa-sway{0%,100%{transform:rotate(0)}50%{transform:rotate(-3deg)}}
@keyframes pa-wag{0%,100%{transform:rotate(2deg)}50%{transform:rotate(-5deg)}}
@keyframes pa-drift{0%,100%{transform:translate(0,0)}50%{transform:translate(6px,-3px)}}
@keyframes pa-rock{0%,100%{transform:rotate(-1.5deg)}50%{transform:rotate(1.5deg)}}
@keyframes pa-hop{0%,45%,100%{transform:translateY(0)}15%{transform:translateY(-6px) scale(.98,1.03)}30%{transform:translateY(0) scale(1.03,.97)}}
@keyframes pa-jump{0%,100%{transform:translateY(0) scale(1.04,.96)}40%{transform:translateY(-12px) scale(.97,1.04)}70%{transform:translateY(0)}}
@keyframes pa-nestle{0%,100%{transform:scale(1)}50%{transform:scale(1.025) translateY(1px)}}
@keyframes pa-moko-tilt{0%,100%{transform:rotate(0)}30%,70%{transform:rotate(-7deg)}}
@keyframes pa-tuft-lean{0%,100%{transform:rotate(0)}30%,70%{transform:rotate(-10deg)}}
@keyframes pa-lean{0%,100%{transform:scale(1)}50%{transform:scale(1.035) translateY(-2px)}}
@keyframes pa-perk{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.09)}}
@keyframes pa-peek{0%{transform:translateY(8px) scaleY(.93)}25%{transform:translateY(0) scaleY(1)}60%{transform:translateY(-2px)}100%{transform:translateY(8px) scaleY(.93)}}
@keyframes pa-relax{0%,100%{transform:scale(1.06)}25%,80%{transform:scale(.98)}}
@keyframes pa-nod{0%,40%,100%{transform:rotate(0)}10%,30%{transform:rotate(3deg) translateY(2px)}20%{transform:rotate(0)}}
@keyframes pa-owl-tilt{0%,100%{transform:rotate(0)}15%,40%{transform:rotate(-16deg)}55%,85%{transform:rotate(10deg)}}
@keyframes pa-wobble{0%,70%,100%{transform:rotate(0)}76%{transform:rotate(-4deg)}84%{transform:rotate(4deg)}92%{transform:rotate(-2deg)}}
@keyframes pa-squish{0%{transform:scale(1)}30%{transform:scale(1.1,.86)}60%{transform:scale(.95,1.06)}100%{transform:scale(1)}}
@keyframes pa-squish-deep{0%{transform:scale(1)}30%{transform:scale(1.18,.76)}60%{transform:scale(.94,1.08)}100%{transform:scale(1)}}
@keyframes pa-puff{0%{transform:scale(1)}25%{transform:scale(1.2)}55%{transform:scale(1.16)}100%{transform:scale(1)}}
@keyframes pa-swirl{0%,100%{transform:rotate(0)}40%{transform:rotate(-16deg)}70%{transform:rotate(6deg)}}
@keyframes pa-fluff{0%{transform:scale(1)}30%{transform:scale(1.08,1.04)}100%{transform:scale(1)}}
@keyframes pa-hop-egg{0%,100%{transform:translateY(0)}35%{transform:translateY(-14px) rotate(-4deg)}70%{transform:translateY(0) rotate(3deg)}}
@media (prefers-reduced-motion:reduce){.pa-pet *{animation:none!important;transition:none!important}}
`;
