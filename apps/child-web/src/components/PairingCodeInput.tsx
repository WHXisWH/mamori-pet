'use client';

import { Button, PetAvatar } from '@ijime/ui';
import { useState } from 'react';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

export function PairingCodeInput({ onSubmit }: { onSubmit: (code: string) => Promise<boolean> }) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].pair;
  const [code, setCode] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="mx-auto flex max-w-md flex-col items-center gap-5 px-4 py-8 text-center"
      data-testid="pairing"
      onSubmit={async (e) => {
        e.preventDefault();
        if (code.length !== 6) return;
        setBusy(true);
        const ok = await onSubmit(code);
        setBusy(false);
        setError(!ok);
      }}
    >
      <PetAvatar characterId="moko" expression={error ? 'worried' : 'happy'} size={140} />
      <h1 className="font-display text-2xl font-bold">{copy.title}</h1>
      <p className="text-sm text-ink-soft">{copy.hint}</p>
      <label className="sr-only" htmlFor="code">
        {copy.hint}
      </label>
      <input
        id="code"
        data-testid="pair-code"
        inputMode="numeric"
        pattern="\d{6}"
        maxLength={6}
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => {
          setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
          setError(false);
        }}
        className="w-full rounded-card border-2 border-cream-deep bg-white px-4 py-4 text-center font-mono text-4xl tracking-[0.5em] focus:border-calm focus:outline-none"
      />
      {error && (
        <p role="alert" data-testid="pair-error" className="text-blush">
          {copy.error}
        </p>
      )}
      <Button
        type="submit"
        size="xl"
        className="w-full"
        disabled={code.length !== 6 || busy}
        data-testid="pair-submit"
      >
        {copy.submit}
      </Button>
    </form>
  );
}
