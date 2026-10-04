'use client';

import type { CharacterId } from '@ijime/api-types';
import { Button, CHARACTER_META, PetAvatar, SELECTABLE_CHARACTERS, SpeechBubble } from '@ijime/ui';
import { useState } from 'react';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

export function CharacterPicker({
  onChoose,
  busy = false,
}: {
  onChoose: (id: CharacterId, name: string) => void;
  busy?: boolean;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].choose;
  const [picked, setPicked] = useState<CharacterId>('moko');
  const [name, setName] = useState('');
  const [hatching, setHatching] = useState(false);
  const meta = CHARACTER_META[picked];

  return (
    <div
      className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-6"
      data-testid="character-picker"
      data-picked={picked}
    >
      <h1 className="font-display text-2xl font-bold">{copy.title}</h1>
      <SpeechBubble tail="bottom" className="text-center">
        {picked === 'hidden' ? copy.egg : `「${meta.tagline}」`}
      </SpeechBubble>
      <div key={picked} className={hatching ? 'animate-bob' : 'animate-pop'}>
        <PetAvatar characterId={picked} expression={hatching ? 'sleepy' : 'happy'} size={180} />
      </div>
      <p className="text-center text-sm text-ink-soft">{meta.personality}</p>
      <ul className="grid w-full grid-cols-3 gap-3" aria-label="なかま">
        {[...SELECTABLE_CHARACTERS, 'hidden' as const].map((id) => (
          <li key={id}>
            <button
              type="button"
              data-testid={`pick-${id}`}
              aria-pressed={picked === id}
              aria-label={CHARACTER_META[id].displayName}
              disabled={busy || id === 'hidden'}
              title={id === 'hidden' ? 'いまは えらべません' : undefined}
              onClick={() => setPicked(id)}
              className={`flex w-full flex-col items-center rounded-card p-2 transition ${picked === id ? 'bg-white shadow-lift ring-4 ring-calm' : 'bg-white/60 hover:bg-white'}`}
            >
              <PetAvatar characterId={id} size={64} animate={false} />
              <span className="mt-1 text-sm font-bold">{CHARACTER_META[id].displayName}</span>
            </button>
          </li>
        ))}
      </ul>
      <label className="w-full">
        <span className="text-sm font-bold text-ink-soft">{copy.name}</span>
        <input
          data-testid="pet-name"
          value={name}
          disabled={busy}
          maxLength={10}
          placeholder={copy.namePlaceholder}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-full border-2 border-cream-deep bg-white px-4 py-3 focus:border-calm focus:outline-none"
        />
      </label>
      <Button
        size="xl"
        className="w-full"
        data-testid="choose-go"
        disabled={busy || hatching}
        onClick={() => {
          if (picked === 'hidden') {
            setHatching(true);
            setTimeout(() => onChoose('hidden', name.trim()), 1200);
          } else onChoose(picked, name.trim());
        }}
      >
        {copy.go}
      </Button>
    </div>
  );
}
