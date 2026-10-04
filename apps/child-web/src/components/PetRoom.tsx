'use client';

import type { CharacterId, Expression } from '@ijime/api-types';
import { PetAvatar, SpeechBubble } from '@ijime/ui';
import type { ReactNode } from 'react';

export function RoomBackdrop({ night }: { night: boolean }) {
  return (
    <svg
      viewBox="0 0 400 300"
      className="absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="wall" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={night ? '#2c3150' : '#fff4e6'} />
          <stop offset="1" stopColor={night ? '#1f2233' : '#fbe9ec'} />
        </linearGradient>
      </defs>
      <rect width="400" height="300" fill="url(#wall)" />
      <rect x="0" y="220" width="400" height="80" fill={night ? '#2a2c3d' : '#f3dfc9'} />
      <ellipse
        cx="200"
        cy="262"
        rx="150"
        ry="26"
        fill={night ? '#343757' : '#f7b8c4'}
        opacity="0.6"
      />
      <g transform="translate(250 40)">
        <rect x="0" y="0" width="110" height="90" rx="14" fill={night ? '#3a4470' : '#dbe7f3'} />
        <rect x="8" y="8" width="94" height="74" rx="10" fill={night ? '#1a1d33' : '#eaf3fb'} />
        {night ? (
          <g fill="#f1c76b">
            <circle cx="70" cy="34" r="12" />
            <circle cx="30" cy="22" r="2" />
            <circle cx="46" cy="60" r="1.5" />
            <circle cx="88" cy="66" r="1.8" />
          </g>
        ) : (
          <g>
            <circle cx="72" cy="30" r="11" fill="#f4c95d" />
            <ellipse cx="40" cy="56" rx="16" ry="8" fill="#ffffff" />
            <ellipse cx="52" cy="50" rx="12" ry="8" fill="#ffffff" />
          </g>
        )}
      </g>
      <g transform="translate(40 60)">
        <rect x="0" y="80" width="90" height="8" rx="4" fill={night ? '#3a3d5c' : '#e6c9a8'} />
        <rect x="8" y="52" width="16" height="28" rx="3" fill="#7fb77e" />
        <rect x="30" y="58" width="12" height="22" rx="3" fill="#6b9ac4" />
        <rect x="48" y="46" width="20" height="34" rx="3" fill="#f2b8c6" />
        <circle cx="78" cy="70" r="9" fill="#f4c95d" />
      </g>
      <g transform="translate(60 150)">
        <rect x="0" y="0" width="34" height="46" rx="8" fill={night ? '#3a3d5c' : '#c9a37a'} />
        <path d="M6 0 q11 -18 22 0" fill="#7fb77e" />
      </g>
    </svg>
  );
}

export function PetRoom({
  characterId,
  expression,
  bubble,
  night,
  children,
  size = 'min(60vw, 260px)',
}: {
  characterId: CharacterId;
  expression: Expression;
  bubble?: ReactNode;
  night: boolean;
  children?: ReactNode;
  size?: string | number;
}) {
  return (
    <section
      aria-label="ペットのおへや"
      className="relative flex min-h-[52dvh] flex-col items-center justify-end overflow-hidden rounded-b-[2.5rem] pb-6"
      data-testid="pet-room"
    >
      <RoomBackdrop night={night} />
      <div className="relative flex flex-col items-center gap-3">
        {bubble && (
          <div className="animate-fade-up" data-testid="greeting-bubble">
            <SpeechBubble tail="bottom" className="max-w-[80vw] text-center">
              {bubble}
            </SpeechBubble>
          </div>
        )}
        <div className="animate-pop">
          <PetAvatar characterId={characterId} expression={expression} size={size} />
        </div>
        {children}
      </div>
    </section>
  );
}
