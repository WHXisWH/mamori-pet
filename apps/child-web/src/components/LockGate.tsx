'use client';

import { Button, PetAvatar } from '@ijime/ui';
import { useState, type ReactNode } from 'react';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

export function PinPad({
  onSubmit,
  error,
  label,
}: {
  onSubmit: (pin: string) => void;
  error?: string | undefined;
  label: string;
}) {
  const [pin, setPin] = useState('');
  const push = (d: string) => {
    const next = (pin + d).slice(0, 4);
    setPin(next);
    if (next.length === 4) {
      onSubmit(next);
      setPin('');
    }
  };
  return (
    <div className="mx-auto w-full max-w-xs text-center" data-testid="pin-pad">
      <p className="font-display text-lg font-bold">{label}</p>
      <div className="mt-4 flex justify-center gap-3" aria-label="入力した合言葉" role="status">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`h-5 w-5 rounded-full border-2 border-calm ${i < pin.length ? 'bg-calm' : 'bg-transparent'}`}
          />
        ))}
      </div>
      {error && (
        <p role="alert" data-testid="pin-error" className="mt-2 text-sm text-blush">
          {error}
        </p>
      )}
      <div className="mt-5 grid grid-cols-3 gap-3">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k, i) =>
          k === '' ? (
            <span key={i} />
          ) : (
            <Button
              key={k}
              variant="secondary"
              size="lg"
              aria-label={k === '⌫' ? '一文字消す' : k}
              onClick={() => (k === '⌫' ? setPin((p) => p.slice(0, -1)) : push(k))}
            >
              {k}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}

export function LockGate({ children }: { children: ReactNode }) {
  const { petLock, unlockedUntil, unlock, gradeBand, characterId, hydrated } = useChildStore();
  const [error, setError] = useState<string | undefined>();
  if (!hydrated) return null;
  if (!petLock || unlockedUntil > Date.now()) return <>{children}</>;
  const copy = COPY[gradeBand];
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-6 px-4">
      <PetAvatar characterId={characterId ?? 'moko'} expression="sleepy" size={140} />
      <PinPad
        label={copy.lock.title}
        error={error}
        onSubmit={(pin) => {
          if (pin === petLock) {
            setError(undefined);
            unlock();
          } else setError(copy.lock.wrong);
        }}
      />
    </div>
  );
}
