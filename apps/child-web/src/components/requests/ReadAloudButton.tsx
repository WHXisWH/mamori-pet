'use client';

import { IconButton } from '@ijime/ui';
import { Volume2 } from 'lucide-react';
import { useEffect } from 'react';

import { REQUEST_COPY } from '@/lib/copy-requests';
import { readLocally } from '@/lib/read-aloud';
import { useChildStore } from '@/lib/store';

export function speakIfEnabled(text: string): void {
  const speech = typeof window === 'undefined' ? undefined : window.speechSynthesis;
  if (!speech) return;
  readLocally(text, speech);
}

export function ReadAloudButton({
  text,
  className = '',
  size = 20,
}: {
  text: string;
  className?: string;
  size?: number;
}) {
  const { readAloud, gradeBand } = useChildStore();
  if (!readAloud) return null;
  return (
    <IconButton
      label={REQUEST_COPY[gradeBand].readAloud}
      data-testid="read-aloud"
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        speakIfEnabled(text);
      }}
    >
      <Volume2 size={size} aria-hidden />
    </IconButton>
  );
}

export function useAutoReadAloud(text: string, enabled = true): void {
  const readAloud = useChildStore((s) => s.readAloud);
  useEffect(() => {
    if (!readAloud || !enabled || !text) return;
    speakIfEnabled(text);
    return () => window.speechSynthesis?.cancel();
  }, [text, readAloud, enabled]);
}
