'use client';

import type { IslandItem, IslandStateRes } from '@ijime/api-types';
import { Button, PetAvatar, SpeechBubble } from '@ijime/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { AppShell } from '@/components/AppShell';
import { IslandSandbox } from '@/components/IslandSandbox';
import { NarrativeRecorder, type Narrative } from '@/components/NarrativeRecorder';
import { RequestError } from '@/components/RequestError';
import { fetchIsland, saveCrisis, saveIsland } from '@/lib/api';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

type Scene = { items: IslandItem[]; selfFigureId?: string };

export default function IslandPage() {
  const { gradeBand, characterId } = useChildStore();
  const copy = COPY[gradeBand];
  const router = useRouter();
  const [state, setState] = useState<IslandStateRes | null>(null);
  const [step, setStep] = useState<'build' | 'tell' | 'done'>('build');
  const [scene, setScene] = useState<Scene | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setState(await fetchIsland());
    } catch (err) {
      setLoadError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const put = async (next: Scene, narrative: Narrative | null) => {
    const result = await saveIsland({ ...next, ...(narrative ? { narrative } : {}) });
    if (result.crisis) {
      saveCrisis(result.crisis);
      router.replace('/safe');
      return false;
    }
    return true;
  };

  const save = async (next: Scene) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await put(next, null)) {
        setScene(next);
        setStep('tell');
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const tell = async (narrative: Narrative | null) => {
    if (!scene || busy) return;
    if (!narrative) {
      setStep('done');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (await put(scene, narrative)) setStep('done');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell back="/" title={copy.island.title}>
      <div
        className="mx-auto max-w-md px-4 py-3 sm:max-w-2xl"
        data-testid="island-page"
        data-step={step}
        data-item-count={scene?.items.length ?? state?.items.length ?? 0}
      >
        <RequestError error={loadError} retry={() => void load()} />
        <RequestError error={error} />
        {step === 'build' &&
          (state ? (
            <IslandSandbox
              catalog={state.catalog}
              initial={{
                items: state.items,
                ...(state.selfFigureId ? { selfFigureId: state.selfFigureId } : {}),
              }}
              season={state.season}
              stage={state.stage}
              busy={busy}
              onSave={(next) => void save(next)}
            />
          ) : (
            !loadError && (
              <p className="py-6 text-center text-ink-soft" aria-busy="true">
                {copy.island.loading}
              </p>
            )
          ))}
        {step === 'tell' && (
          <NarrativeRecorder
            voiceEnabled={false}
            busy={busy}
            prompt={copy.island.tellPrompt}
            onDone={(n) => void tell(n)}
          />
        )}
        {step === 'done' && (
          <div
            className="flex flex-col items-center gap-4 py-6 text-center"
            data-testid="island-saved"
          >
            <SpeechBubble tail="bottom">
              {copy.island.saved}
              <br />
              {copy.island.savedBody}
            </SpeechBubble>
            <PetAvatar characterId={characterId ?? 'moko'} expression="celebrate" size={150} />
            <Button size="xl" onClick={() => router.push('/')}>
              {copy.back}
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
