'use client';

import type { CharacterId, Expression } from '@ijime/api-types';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';

import { CHARACTER_META } from './meta.js';
import { PET_CSS, renderPetArt, type PetState } from './petArt.js';

export type PetAvatarProps = {
  characterId: CharacterId;
  expression?: Expression;
  /** idle: busy with its own thing; attend: turned to the child; listen: the child is typing or talking. */
  state?: PetState;
  size?: number | string;
  animate?: boolean;
  /** Squish and smile when tapped. */
  reactToTap?: boolean;
  /** Eyes follow the pointer while attending. */
  followPointer?: boolean;
  /** Drop the felt texture. Defaults to on for numeric sizes of 48px or less. */
  lite?: boolean;
  className?: string;
  title?: string;
  style?: CSSProperties;
};

const JOY_MS = 900;
const LITE_MAX_PX = 48;
const EYE_FOLLOW_PX = 2.2;

export function PetAvatar({
  characterId,
  expression = 'happy',
  state = 'attend',
  size = 160,
  animate = true,
  reactToTap = true,
  followPointer = false,
  lite,
  className,
  title,
  style,
}: PetAvatarProps): ReactElement {
  // character in the id too: two separate React roots on one page must still not share gradients across characters
  const uid = `pa-${characterId}-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const useLite = lite ?? (typeof size === 'number' && size <= LITE_MAX_PX);
  const markup = useMemo(
    () => renderPetArt(characterId, expression, { uid, lite: useLite }),
    [characterId, expression, uid, useLite],
  );
  const ref = useRef<SVGSVGElement>(null);
  const [tap, setTap] = useState(0);
  const [joy, setJoy] = useState(false);

  useEffect(() => {
    if (!joy) return;
    const t = setTimeout(() => setJoy(false), JOY_MS);
    return () => clearTimeout(t);
  }, [joy, tap]);

  useEffect(() => {
    const svg = ref.current;
    if (!followPointer || state === 'idle' || !svg) return;
    const onMove = (e: PointerEvent) => {
      const r = svg.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height * 0.6);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 300) * EYE_FOLLOW_PX;
      for (const eyes of svg.querySelectorAll('.pa-eA')) {
        eyes.setAttribute(
          'transform',
          `translate(${((dx / d) * k).toFixed(2)} ${((dy / d) * k).toFixed(2)})`,
        );
      }
    };
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('pointermove', onMove);
      for (const eyes of svg.querySelectorAll('.pa-eA')) eyes.removeAttribute('transform');
    };
  }, [followPointer, state, markup]);

  const label =
    title ??
    `${CHARACTER_META[characterId].displayName}（${state === 'idle' ? 'あそんでいる' : expressionLabel(expression)}）`;
  const classes = [
    'pa-pet',
    `pa-c-${characterId}`,
    `pa-e-${expression}`,
    state === 'idle' ? 'pa-idle' : 'pa-attend',
    state === 'listen' ? 'pa-listening' : '',
    animate ? 'pa-anim' : '',
    tap > 0 ? 'pa-tapped' : '',
    joy ? 'pa-joy' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <svg
      ref={ref}
      viewBox="0 0 200 200"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      className={classes}
      style={style}
      data-character={characterId}
      data-expression={expression}
      data-state={state}
      // React after the click, not on pointerdown: the squish re-mounts the drawing, and replacing the
      // shape under the finger before pointerup stops the browser from delivering the click to a
      // surrounding link or button (the home-screen pet is the link into chat).
      onClick={
        reactToTap
          ? () => {
              setTap((n) => n + 1);
              setJoy(true);
            }
          : undefined
      }
    >
      <style>{PET_CSS}</style>
      {/* markup is generated from our own drawing code, never from user input; a new key per tap restarts the squish */}
      <g key={tap} dangerouslySetInnerHTML={{ __html: markup }} />
    </svg>
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
