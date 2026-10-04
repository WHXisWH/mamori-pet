'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ChildHomeRes, ChoosePetRes } from '@ijime/api-types';

import { AppShell } from '@/components/AppShell';
import { CharacterPicker } from '@/components/CharacterPicker';
import { useChildStore } from '@/lib/store';
import { childRequest } from '@/lib/api';
import { RequestError } from '@/components/RequestError';

export default function ChoosePage() {
  const { choosePet, characterId } = useChildStore();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [currentPetId, setCurrentPetId] = useState<string | null>(null);
  const [carry, setCarry] = useState(false);
  const operation = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => {
    if (characterId)
      void childRequest<ChildHomeRes>('/v1/child/home')
        .then((home) => setCurrentPetId(home.pet.petId))
        .catch(setError);
  }, [characterId]);
  return (
    <AppShell {...(characterId ? { back: '/' } : {})} requireLock={false}>
      <CharacterPicker
        busy={busy}
        onChoose={async (id, name) => {
          setBusy(true);
          setError(null);
          const payload = {
            characterId: id,
            petName: name,
            ...(carry && currentPetId ? { carryMemoryFrom: currentPetId } : {}),
          };
          const fingerprint = JSON.stringify(payload);
          if (operation.current?.fingerprint !== fingerprint)
            operation.current = { fingerprint, key: crypto.randomUUID() };
          try {
            const pet = await childRequest<ChoosePetRes>('/v1/child/pets', {
              method: 'POST',
              headers: { 'Idempotency-Key': operation.current.key },
              body: fingerprint,
            });
            choosePet(pet.characterId, name, pet.hiddenVariantId);
            router.replace('/');
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      />
      <div className="mx-auto max-w-md px-4 pb-6">
        {currentPetId && (
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={carry}
              disabled={busy}
              onChange={(e) => setCarry(e.target.checked)}
            />
            <span>前の なかまの きおくを、この なかまにも つたえる</span>
          </label>
        )}
        <RequestError error={error} />
      </div>
    </AppShell>
  );
}
