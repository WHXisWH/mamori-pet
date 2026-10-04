'use client';

import type { CrisisPayload, Expression, PetAction, TypingMetrics } from '@ijime/api-types';
import { Button, PetAvatar, SpeechBubble } from '@ijime/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createChatClient, type ChatClient } from '@/lib/chat-client';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';
import { saveCrisis } from '@/lib/api';
import { VoiceClient, type VoiceStatus } from '@/lib/voice-client';
import { readLocally } from '@/lib/read-aloud';
import { MemoryProposal } from './MemoryProposal';

import { TypingMetricsInput } from './TypingMetricsInput';

type Msg = {
  id: string;
  role: 'child' | 'pet';
  text: string;
  streaming?: boolean;
  readAloud?: boolean;
};
type Status = 'idle' | 'sending' | 'streaming';

export function ChatPanel({ client: injected }: { client?: ChatClient }) {
  const { gradeBand, characterId, dataSources, readAloud } = useChildStore();
  const copy = COPY[gradeBand].chat;
  const router = useRouter();
  const client = useMemo(() => injected ?? createChatClient(), [injected]);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [expression, setExpression] = useState<Expression>('happy');
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [offers, setOffers] = useState<PetAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [voiceError, setVoiceError] = useState(false);
  const [voiceCaption, setVoiceCaption] = useState('');
  const [failedText, setFailedText] = useState<string | null>(null);
  const [speechUnavailable, setSpeechUnavailable] = useState(false);
  const spokenRef = useRef(new Set<string>());
  const voiceRef = useRef<VoiceClient | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    client
      .startSession()
      .then((s) => {
        if (cancelled) return;
        setSessionId(s.sessionId);
        setMessages([{ id: 'open', role: 'pet', text: s.openingMessage, readAloud: true }]);
      })
      .catch(() => {
        if (!cancelled) setError('start');
      });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      voiceRef.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, [client, startAttempt]);

  useEffect(() => {
    const stopWhenHidden = () => {
      if (document.hidden) {
        voiceRef.current?.stop();
        window.speechSynthesis?.cancel();
      }
    };
    document.addEventListener('visibilitychange', stopWhenHidden);
    return () => document.removeEventListener('visibilitychange', stopWhenHidden);
  }, []);

  useEffect(() => {
    if (!dataSources.voice) voiceRef.current?.stop();
  }, [dataSources.voice]);

  useEffect(() => {
    const speech = window.speechSynthesis;
    if (!readAloud || voiceStatus !== 'idle' || status !== 'idle' || document.hidden) {
      speech?.cancel();
      setSpeechUnavailable(false);
      return;
    }
    const latest = messages.at(-1);
    if (!latest?.readAloud || latest.streaming || spokenRef.current.has(latest.id)) return;
    const speak = () => {
      if (document.hidden || spokenRef.current.has(latest.id)) return;
      const available = speech ? readLocally(latest.text, speech) : false;
      setSpeechUnavailable(!available);
      if (available) spokenRef.current.add(latest.id);
    };
    speak();
    speech?.addEventListener('voiceschanged', speak);
    return () => {
      speech?.removeEventListener('voiceschanged', speak);
      speech?.cancel();
    };
  }, [messages, readAloud, voiceStatus, status]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, quickReplies, offers]);

  const handleCrisis = useCallback(
    (payload: CrisisPayload) => {
      abortRef.current?.abort();
      voiceRef.current?.stop();
      window.speechSynthesis?.cancel();
      saveCrisis(payload);
      router.replace('/safe');
    },
    [router],
  );

  const onAction = useCallback((action: PetAction) => {
    if (action.type === 'set_expression') setExpression(action.expression);
    else if (action.type === 'quick_replies') setQuickReplies(action.options);
    else
      setOffers((items) =>
        action.type === 'memory_proposal' &&
        items.some(
          (item) => item.type === 'memory_proposal' && item.proposalId === action.proposalId,
        )
          ? items
          : [...items, action],
      );
  }, []);

  const toggleVoice = () => {
    window.speechSynthesis?.cancel();
    if (voiceStatus !== 'idle') {
      voiceRef.current?.stop();
      return;
    }
    setVoiceError(false);
    setVoiceCaption('');
    setQuickReplies([]);
    const voice = new VoiceClient({
      onStatus: setVoiceStatus,
      onChildText: (text, final) => {
        setVoiceCaption(final ? '' : text);
        if (final)
          setMessages((items) => [...items, { id: crypto.randomUUID(), role: 'child', text }]);
      },
      onPetText: (text) =>
        setMessages((items) => [...items, { id: crypto.randomUUID(), role: 'pet', text }]),
      onAction,
      onCrisis: (payload) =>
        handleCrisis({ crisisId: '', message: payload.message, resources: payload.resources }),
      onError: () => setVoiceError(true),
    });
    voiceRef.current = voice;
    void voice.start();
  };

  const send = useCallback(
    (text: string, typing?: TypingMetrics, inputMode: 'typed' | 'quick_reply' = 'typed') => {
      if (!sessionId || status !== 'idle' || voiceStatus !== 'idle') return;
      setError(null);
      setFailedText(null);
      setQuickReplies([]);
      setOffers([]);
      setStatus('sending');
      const childId = `c_${Date.now()}`;
      const petId = `p_${Date.now()}`;
      setMessages((m) => [...m, { id: childId, role: 'child', text }]);
      const controller = new AbortController();
      abortRef.current = controller;
      const req = {
        text,
        inputMode,
        clientSentAt: new Date().toISOString(),
        ...(typing && dataSources.typing ? { typing } : {}),
      };
      const sendFailed = () => {
        if (controller.signal.aborted) return;
        setMessages((m) => m.filter((x) => x.id !== petId));
        setError('send');
        setFailedText(text);
        setStatus('idle');
      };
      void client
        .send(
          sessionId,
          req,
          {
            onMeta: () => {
              setStatus('streaming');
              setMessages((m) => [
                ...m,
                { id: petId, role: 'pet', text: '', streaming: true, readAloud: true },
              ]);
            },
            onDelta: (delta) =>
              setMessages((m) =>
                m.map((x) => (x.id === petId ? { ...x, text: x.text + delta } : x)),
              ),
            onAction,
            onCrisis: handleCrisis,
            onDone: () => {
              setMessages((m) => m.map((x) => (x.id === petId ? { ...x, streaming: false } : x)));
              setStatus('idle');
            },
            onError: sendFailed,
          },
          controller.signal,
        )
        .catch(sendFailed);
    },
    [client, sessionId, status, voiceStatus, dataSources.typing, handleCrisis, onAction],
  );

  return (
    <div
      className="mx-auto flex h-full min-h-0 w-full max-w-md flex-col"
      data-testid="chat-panel"
      data-status={status}
    >
      <div className="flex shrink-0 items-center gap-3 px-4 pb-2">
        <div key={expression} className="animate-pop">
          <PetAvatar characterId={characterId ?? 'moko'} expression={expression} size={56} />
        </div>
        <p className="text-sm text-ink-soft" aria-live="polite">
          {status === 'sending' ? copy.thinking : ''}
        </p>
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-2"
        role="log"
        aria-live="polite"
      >
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.role === 'child' ? 'justify-end' : 'justify-start'}`}
          >
            <SpeechBubble
              tone={m.role === 'child' ? 'child' : 'pet'}
              tail={m.role === 'child' ? 'right' : 'left'}
            >
              <span data-testid={`msg-${m.role}`}>{m.text}</span>
              {m.streaming && (
                <span aria-hidden="true" className="ml-1 inline-block animate-bob">
                  …
                </span>
              )}
            </SpeechBubble>
          </div>
        ))}
        {offers.map((o, i) => (
          <div key={i} className="flex justify-start">
            {o.type === 'memory_proposal' && <MemoryProposal proposal={o} />}
            {o.type === 'offer_tell_adult' && (
              <Link href={`/tell?consultationId=${o.consultationId}`}>
                <Button variant="calm" data-testid="offer-tell-adult">
                  🤝 {COPY[gradeBand].shelf.tell}
                </Button>
              </Link>
            )}
            {o.type === 'show_help_resources' && (
              <Link href="/help">
                <Button variant="calm">{COPY[gradeBand].helpResources}</Button>
              </Link>
            )}
            {o.type === 'suggest_game' && (
              <Link
                href={
                  o.requestId
                    ? `/requests/${encodeURIComponent(o.requestId)}`
                    : o.game === 'story'
                      ? '/draw/story'
                      : '/island'
                }
                data-testid="suggest-game"
              >
                <Button variant="secondary">
                  💌{' '}
                  {o.requestId
                    ? o.game === 'story' || o.game === 'drawing' || o.game === 'pet_worry'
                      ? COPY[gradeBand].request.heading[o.game]
                      : COPY[gradeBand].request.open
                    : o.game === 'story'
                      ? COPY[gradeBand].shelf.drawStory
                      : COPY[gradeBand].shelf.island}
                </Button>
              </Link>
            )}
          </div>
        ))}
        {error && (
          <div
            role="alert"
            className="space-y-2 rounded-xl bg-cream-deep p-3 text-sm text-ink-soft"
          >
            <p>{COPY[gradeBand].offline}</p>
            <Button
              variant="secondary"
              onClick={() =>
                error === 'start' ? setStartAttempt((n) => n + 1) : failedText && send(failedText)
              }
            >
              もういちど
            </Button>
          </div>
        )}
        {speechUnavailable && (
          <p role="status" data-testid="speech-unavailable" className="text-sm text-ink-soft">
            この端末では 日本語のよみあげが 使えません。
          </p>
        )}
        {voiceError && (
          <p role="alert" data-testid="voice-error" className="text-sm text-ink-soft">
            音声に つながりませんでした。マイクの きょかと Google 音声の せっていを
            かくにんしてね。文字では おはなしできます。
          </p>
        )}
      </div>

      <div className="shrink-0 space-y-2 px-4 pt-2 pb-4">
        {voiceStatus !== 'idle' && (
          <p role="status" data-testid="voice-status">
            {voiceStatus === 'listening'
              ? 'きいているよ'
              : voiceStatus === 'reconnecting'
                ? 'つなぎなおしています'
                : '音声に つないでいます'}
          </p>
        )}
        {voiceCaption && (
          <p aria-live="polite" className="break-words text-sm">
            {voiceCaption}
          </p>
        )}
        {quickReplies.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="quick-replies">
            {quickReplies.map((q) => (
              <Button
                key={q}
                variant="secondary"
                size="md"
                disabled={voiceStatus !== 'idle' || status !== 'idle'}
                onClick={() => send(q, undefined, 'quick_reply')}
              >
                {q}
              </Button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2">
          <div className="contents">
            <TypingMetricsInput
              enabled={dataSources.typing}
              disabled={status !== 'idle' || !sessionId || voiceStatus !== 'idle'}
              placeholder={copy.placeholder}
              sendLabel={copy.send}
              onSubmit={(t, typing) => send(t, typing)}
            />
          </div>
          {dataSources.voice && (
            <Button
              variant="secondary"
              size="lg"
              aria-label={voiceStatus === 'idle' ? copy.voice : '音声を おわる'}
              aria-pressed={voiceStatus !== 'idle'}
              data-testid="voice-toggle"
              disabled={status !== 'idle'}
              onClick={toggleVoice}
            >
              {voiceStatus === 'idle' ? '🎙️' : '■'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
