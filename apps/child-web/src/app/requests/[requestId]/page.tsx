'use client';

import type { CrisisPayload, PetRequest, PetRequestCompleteReq } from '@ijime/api-types';
import { Button, PetAvatar, SpeechBubble } from '@ijime/ui';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { AppShell } from '@/components/AppShell';
import { DrawingCanvas } from '@/components/DrawingCanvas';
import { FuriganaText } from '@/components/FuriganaText';
import { NarrativeRecorder, type Narrative } from '@/components/NarrativeRecorder';
import { RequestError } from '@/components/RequestError';
import { PetRequestIntro } from '@/components/requests/PetRequestIntro';
import { ReadAloudButton } from '@/components/requests/ReadAloudButton';
import { RewardReveal } from '@/components/requests/RewardReveal';
import { StoryEndingPicker } from '@/components/requests/StoryEndingPicker';
import { WorryOptions } from '@/components/requests/WorryOptions';
import { saveCrisis } from '@/lib/api';
import {
  completePetRequest,
  declinePetRequest,
  fetchPetRequest,
  uploadRequestArtwork,
} from '@/lib/api-requests';
import { REQUEST_COPY } from '@/lib/copy-requests';
import { useChildStore } from '@/lib/store';

type Step =
  | 'loading'
  | 'missing'
  | 'intro'
  | 'draw'
  | 'save'
  | 'tell'
  | 'story'
  | 'worry'
  | 'worry_reply'
  | 'reward';

type Outcome = { rewardItemId: string; petReply: string };

export default function PetRequestPage() {
  const params = useParams<{ requestId: string }>();
  const requestId = params.requestId;
  const router = useRouter();
  const { gradeBand, characterId, dataSources } = useChildStore();
  const copy = REQUEST_COPY[gradeBand];

  const [request, setRequest] = useState<PetRequest | null>(null);
  const [step, setStep] = useState<Step>('loading');
  const [png, setPng] = useState<Blob | null>(null);
  const [save, setSave] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const found = await fetchPetRequest(requestId);
      setRequest(found);
      setStep(found ? 'intro' : 'missing');
    } catch (err) {
      setError(err);
    }
  }, [requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!png) return;
    const url = URL.createObjectURL(png);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [png]);

  const handleCrisis = useCallback(
    (payload: CrisisPayload) => {
      window.speechSynthesis?.cancel();
      saveCrisis(payload);
      router.replace('/safe');
    },
    [router],
  );

  const complete = useCallback(
    async (body: PetRequestCompleteReq): Promise<boolean> => {
      const result = await completePetRequest(requestId, body);
      if (result.crisis) {
        handleCrisis(result.crisis);
        return false;
      }
      setOutcome({ rewardItemId: result.rewardItemId, petReply: result.petReply });
      return true;
    },
    [requestId, handleCrisis],
  );

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  function startMain(type: PetRequest['type']) {
    setStep(type === 'drawing' ? 'draw' : type === 'story' ? 'story' : 'worry');
  }

  function afterDrawing(image: Blob) {
    setPng(image);
    if (dataSources.artwork_save) setStep('save');
    else {
      setSave(false);
      setStep('tell');
    }
  }

  function submitArtwork(narrative: Narrative | null) {
    if (!request || !png) return;
    void run(async () => {
      const artwork = await uploadRequestArtwork({
        png,
        type: request.type === 'story' ? 'story' : 'drawing',
        requestId: request.requestId,
        promptId: request.promptId,
        save: save && dataSources.artwork_save,
        narrative,
      });
      if (artwork.crisis) {
        handleCrisis(artwork.crisis);
        return;
      }
      const body: PetRequestCompleteReq =
        request.type === 'story'
          ? { type: 'story', artworkId: artwork.artworkId }
          : { type: 'drawing', artworkId: artwork.artworkId };
      if (await complete(body)) setStep('reward');
    });
  }

  function decline() {
    void run(async () => {
      await declinePetRequest(requestId);
      router.replace('/');
    });
  }

  const canDecline = ['intro', 'draw', 'save', 'tell', 'story', 'worry'].includes(step);
  const drawingMode = request?.type === 'story' ? 'story' : 'drawing';
  const narrativeDefault = gradeBand === 'low' ? 'voice' : 'typed';

  return (
    <AppShell back="/" title={copy.title}>
      <div
        className="mx-auto flex max-w-md flex-col gap-4 px-4 py-3"
        data-testid="pet-request-page"
        data-step={step}
      >
        <RequestError error={error} {...(step === 'loading' ? { retry: () => void load() } : {})} />

        {step === 'loading' && !error && (
          <p role="status" className="py-8 text-center text-ink-soft">
            {copy.loading}
          </p>
        )}

        {step === 'missing' && (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <SpeechBubble tail="bottom">{copy.notFound}</SpeechBubble>
            <PetAvatar characterId={characterId ?? 'moko'} expression="caring" size={120} />
            <Button
              size="xl"
              data-testid="request-missing-home"
              onClick={() => router.replace('/')}
            >
              {copy.home}
            </Button>
          </div>
        )}

        {request && step === 'intro' && (
          <PetRequestIntro request={request} busy={busy} onStart={() => startMain(request.type)} />
        )}

        {request && step === 'draw' && (
          <>
            <div
              className="flex items-start gap-2 rounded-card bg-white p-3 shadow-soft"
              data-testid="request-prompt"
            >
              <p className="font-display flex-1 font-bold leading-relaxed">
                <FuriganaText text={request.promptText} enabled={gradeBand === 'low'} />
              </p>
              <ReadAloudButton text={request.promptText} className="shrink-0" />
            </div>
            <DrawingCanvas
              mode={drawingMode}
              doneLabel={request.type === 'story' ? copy.story.drawDone : copy.drawing.done}
              onDone={afterDrawing}
            />
          </>
        )}

        {request && step === 'save' && (
          <div className="flex flex-col items-center gap-4 text-center" data-testid="save-choice">
            {previewUrl && (
              <img
                src={previewUrl}
                alt=""
                className="aspect-square w-full max-w-56 rounded-card border border-ink/15 bg-white object-contain"
              />
            )}
            <p className="font-display text-lg font-bold">{copy.drawing.saveTitle}</p>
            <p className="text-sm leading-relaxed text-ink-soft">
              {copy.drawing.saveExplain}
              <br />
              {copy.drawing.noSaveExplain}
            </p>
            <div className="flex w-full flex-col gap-2 sm:flex-row">
              <Button
                className="flex-1"
                data-testid="artwork-save-yes"
                onClick={() => {
                  setSave(true);
                  setStep('tell');
                }}
              >
                {copy.drawing.save}
              </Button>
              <Button
                variant="secondary"
                className="flex-1"
                data-testid="artwork-save-no"
                onClick={() => {
                  setSave(false);
                  setStep('tell');
                }}
              >
                {copy.drawing.noSave}
              </Button>
            </div>
          </div>
        )}

        {request && step === 'tell' && (
          <>
            {!dataSources.artwork_save && (
              <p role="status" className="text-center text-sm text-ink-soft" data-testid="save-off">
                {copy.drawing.saveOff}
              </p>
            )}
            <NarrativeRecorder
              voiceEnabled={dataSources.voice}
              defaultMode={narrativeDefault}
              busy={busy}
              prompt={request.type === 'story' ? copy.story.tellPrompt : copy.drawing.tellPrompt}
              onDone={submitArtwork}
            />
          </>
        )}

        {request && step === 'story' && (
          <>
            <div
              className="flex items-start gap-2 rounded-card bg-white p-4 shadow-soft"
              data-testid="story-opening"
            >
              <div className="flex-1">
                <p className="text-sm text-ink-soft">
                  <FuriganaText text={copy.story.opening} enabled={gradeBand === 'low'} />
                </p>
                <p className="font-display text-lg font-bold leading-relaxed">
                  <FuriganaText text={request.promptText} enabled={gradeBand === 'low'} />
                </p>
              </div>
              <ReadAloudButton text={request.promptText} className="shrink-0" />
            </div>
            <StoryEndingPicker
              gradeBand={gradeBand}
              options={request.options ?? []}
              busy={busy}
              onDone={(ending) => {
                if ('draw' in ending) {
                  setStep('draw');
                  return;
                }
                void run(async () => {
                  if (await complete({ type: 'story', ending })) setStep('reward');
                });
              }}
            />
          </>
        )}

        {request && step === 'worry' && (
          <>
            <div className="flex w-full items-start justify-center gap-2" data-testid="worry-setup">
              <SpeechBubble tail="bottom" className="text-left">
                <FuriganaText text={request.promptText} enabled={gradeBand === 'low'} />
              </SpeechBubble>
              <ReadAloudButton text={request.promptText} className="shrink-0" />
            </div>
            <div className="flex justify-center">
              <PetAvatar characterId={characterId ?? 'moko'} expression="worried" size={110} />
            </div>
            <WorryOptions
              options={request.options ?? []}
              busy={busy}
              onPick={(optionId) =>
                void run(async () => {
                  if (await complete({ type: 'pet_worry', optionId })) setStep('worry_reply');
                })
              }
            />
          </>
        )}

        {request && step === 'worry_reply' && outcome && (
          <div className="flex flex-col items-center gap-4 text-center" data-testid="worry-reply">
            <div className="flex w-full items-start justify-center gap-2">
              <SpeechBubble tail="bottom" className="text-left">
                <FuriganaText text={outcome.petReply} enabled={gradeBand === 'low'} />
              </SpeechBubble>
              <ReadAloudButton text={outcome.petReply} className="shrink-0" />
            </div>
            <PetAvatar characterId={characterId ?? 'moko'} expression="together" size={130} />
            <Button
              size="xl"
              className="w-full"
              data-testid="worry-next"
              onClick={() => setStep('reward')}
            >
              {copy.worry.next}
            </Button>
          </div>
        )}

        {step === 'reward' && outcome && (
          <>
            {request?.type !== 'pet_worry' && outcome.petReply && (
              <div className="flex w-full items-start justify-center gap-2" data-testid="pet-reply">
                <SpeechBubble tail="none" className="text-left">
                  <FuriganaText text={outcome.petReply} enabled={gradeBand === 'low'} />
                </SpeechBubble>
                <ReadAloudButton text={outcome.petReply} className="shrink-0" />
              </div>
            )}
            <RewardReveal itemId={outcome.rewardItemId} onPlaced={() => router.replace('/')} />
          </>
        )}

        {canDecline && (
          <Button
            variant="ghost"
            size="md"
            className="self-center"
            data-testid="request-decline"
            disabled={busy}
            onClick={decline}
          >
            {copy.notNow}
          </Button>
        )}
      </div>
    </AppShell>
  );
}
