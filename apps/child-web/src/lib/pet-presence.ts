'use client';

import type { PetState } from '@ijime/ui';
import { useEffect, useState } from 'react';

// The pet is busy with its own thing until the child shows up, turns to greet them,
// and goes back to playing when nothing has happened for a while (design sheet 第2稿).
const TURN_AFTER_ARRIVAL_MS = 900;
const BACK_TO_PLAY_AFTER_MS = 20_000;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'focusin'] as const;

export function usePetPresence(): Exclude<PetState, 'listen'> {
  const [state, setState] = useState<'idle' | 'attend'>('idle');

  useEffect(() => {
    let backToPlay: ReturnType<typeof setTimeout> | undefined;
    const attend = () => {
      setState('attend');
      clearTimeout(backToPlay);
      backToPlay = setTimeout(() => setState('idle'), BACK_TO_PLAY_AFTER_MS);
    };
    const arrival = setTimeout(attend, TURN_AFTER_ARRIVAL_MS);
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, attend, { passive: true });
    return () => {
      clearTimeout(arrival);
      clearTimeout(backToPlay);
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, attend);
    };
  }, []);

  return state;
}
