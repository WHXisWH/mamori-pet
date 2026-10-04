'use client';

import type { ArtworkRes, StoryPromptRes } from '@ijime/api-types';
import { Button, PetAvatar, SpeechBubble } from '@ijime/ui';
import { Share2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from './AppShell';
import { DrawingCanvas } from './DrawingCanvas';
import { NarrativeRecorder, type Narrative } from './NarrativeRecorder';
import { RequestError } from './RequestError';
import { childRequest, saveCrisis } from '@/lib/api';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

export function ArtworkActivity({ type }: { type: 'self_portrait' | 'story' }) {
  const { gradeBand, characterId, dataSources } = useChildStore();
  const copy = COPY[gradeBand];
  const router = useRouter();
  const [step, setStep] = useState<'draw' | 'tell' | 'done'>('draw');
  const [png, setPng] = useState<Blob | null>(null);
  const [save, setSave] = useState(false);
  const [prompt, setPrompt] = useState<StoryPromptRes | null>(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [artworkId, setArtworkId] = useState<string | null>(null);
  const [confirmShare, setConfirmShare] = useState(false);
  const [shared, setShared] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  useEffect(() => {
    if (!png) return;
    const url = URL.createObjectURL(png);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [png]);
  const loadPrompt = useCallback(async () => {
    setError(null);
    try {
      setPrompt(await childRequest<StoryPromptRes>('/v1/child/games/story-prompt'));
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    if (type === 'story') void loadPrompt();
  }, [type, loadPrompt]);

  async function submit(narrative: Narrative | null) {
    if (!png || busy) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set('image', png, 'drawing.png');
    form.set('type', type);
    form.set('save', String(save && dataSources.artwork_save));
    form.set('narrativeMode', narrative?.mode ?? 'typed');
    if (narrative) form.set('narrativeText', narrative.text);
    if (prompt) form.set('promptId', prompt.promptId);
    try {
      const result = await childRequest<ArtworkRes>('/v1/child/artworks', {
        method: 'POST',
        body: form,
      });
      if (result.crisis) {
        saveCrisis(result.crisis);
        router.replace('/safe');
        return;
      }
      setReply(result.petPrompt);
      setArtworkId(result.artworkId);
      setStep('done');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function changeShare(next: boolean) {
    if (!artworkId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await childRequest<void>(`/v1/child/artworks/${encodeURIComponent(artworkId)}/share`, {
        method: next ? 'POST' : 'DELETE',
      });
      setShared(next);
      setRevoked(!next);
      setConfirmShare(false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell back="/" title={type === 'story' ? copy.draw.storyTitle : copy.draw.selfTitle}>
      <div className="mx-auto max-w-md px-4 py-3" data-testid="draw-page" data-step={step}>
        <RequestError
          error={error}
          {...(type === 'story' && !prompt ? { retry: () => void loadPrompt() } : {})}
        />
        {step === 'draw' && (type !== 'story' || prompt) && (
          <>
            {prompt && (
              <div className="mb-3 text-center" data-testid="story-prompt">
                <p className="font-display text-lg font-bold leading-relaxed">{prompt.text}</p>
              </div>
            )}
            <DrawingCanvas
              onDone={(image) => {
                setPng(image);
                setStep('tell');
              }}
            />
            {dataSources.artwork_save && (
              <label className="mt-3 flex items-center justify-center gap-2 text-sm">
                <input
                  data-testid="artwork-save"
                  type="checkbox"
                  checked={save}
                  onChange={(e) => setSave(e.target.checked)}
                />
                {save ? copy.draw.save : copy.draw.noSave}
              </label>
            )}
          </>
        )}
        {step === 'tell' && (
          <NarrativeRecorder voiceEnabled={false} busy={busy} onDone={(n) => void submit(n)} />
        )}
        {step === 'done' && (
          <div
            className="flex flex-col items-center gap-4 py-6 text-center"
            data-png-bytes={png?.size ?? 0}
          >
            <SpeechBubble tail="bottom">{reply}</SpeechBubble>
            <PetAvatar characterId={characterId ?? 'moko'} expression="together" size={150} />
            {save && dataSources.artwork_save && artworkId && (
              <div className="flex w-full flex-col items-center gap-3 border-y border-ink/15 py-4">
                {revoked && (
                  <p
                    role="status"
                    className="text-sm leading-relaxed"
                    data-testid="artwork-unshared"
                  >
                    あたらしく みせるのを やめたよ。
                    <br />
                    さっきの リンクは、さいだい5ふん ひらけることが あるよ。
                    <br />
                    もう みた えや、あいてが のこした えは けせないよ。
                  </p>
                )}
                {shared ? (
                  <>
                    <p role="status" data-testid="artwork-shared">
                      おうちのひとに みせたよ
                    </p>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      data-testid="artwork-unshare"
                      onClick={() => void changeShare(false)}
                    >
                      <Undo2 size={18} aria-hidden />
                      みせるのを やめる
                    </Button>
                  </>
                ) : confirmShare ? (
                  <div
                    className="flex w-full flex-col items-center gap-3"
                    role="group"
                    aria-label="えを みせる かくにん"
                    data-testid="artwork-share-confirmation"
                  >
                    {previewUrl && (
                      <img
                        src={previewUrl}
                        alt="みせる え"
                        className="aspect-square w-full max-w-64 rounded-md border border-ink/15 bg-white object-contain"
                      />
                    )}
                    <p className="leading-relaxed">
                      この えを おうちのひとに みせる？
                      <br />
                      おはなしの ことばは みせないよ。
                    </p>
                    <p className="text-sm leading-relaxed">
                      みせた あとで、あいてが のこした えは けせないよ。
                    </p>
                    <div className="flex w-full flex-wrap justify-center gap-2">
                      <Button
                        disabled={busy}
                        data-testid="artwork-share-confirm"
                        onClick={() => void changeShare(true)}
                      >
                        <Share2 size={18} aria-hidden />
                        この えを みせる
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        data-testid="artwork-share-cancel"
                        onClick={() => setConfirmShare(false)}
                      >
                        いまは やめる
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    data-testid="artwork-share"
                    onClick={() => setConfirmShare(true)}
                  >
                    <Share2 size={18} aria-hidden />
                    おうちのひとに みせる
                  </Button>
                )}
              </div>
            )}
            <Button size="xl" disabled={busy} onClick={() => router.push('/')}>
              {copy.back}
            </Button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
