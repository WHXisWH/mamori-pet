'use client';

import type {
  ChatSafetyRes,
  CrisisPayload,
  Expression,
  MessagesRes,
  PetAction,
  SessionsRes,
  TypingMetrics,
} from '@ijime/api-types';
import { Button, PetAvatar, SpeechBubble } from '@ijime/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createChatClient, type ChatClient, type ChatEventHandlers } from '@/lib/chat-client';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';
import { ChildApiError, childRequest, errorMessage, saveCrisis } from '@/lib/api';
import { VoiceClient, type VoiceFailure, type VoiceStatus } from '@/lib/voice-client';
import { readLocally } from '@/lib/read-aloud';
import { MemoryProposal } from './MemoryProposal';
import { FuriganaText } from './FuriganaText';
import { PendingReviewHelp } from './PendingReviewHelp';
import { RestReminder } from './RestReminder';

import { TypingMetricsInput } from './TypingMetricsInput';

type Msg = {
  id: string;
  role: 'child' | 'pet';
  text: string;
  streaming?: boolean;
  readAloud?: boolean;
};
type Status = 'idle' | 'sending' | 'streaming';
type PendingReview = Extract<ChatSafetyRes, { status: 'pending_review' }>;
type RetryTarget = { messageId: string; reason: 'review' | 'fallback' };

export function ChatPanel({ client: injected }: { client?: ChatClient }) {
  const { childId, gradeBand, characterId, dataSources, readAloud } = useChildStore();
  const copy = COPY[gradeBand].chat;
  const router = useRouter();
  const client = useMemo(() => injected ?? createChatClient(), [injected]);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [expression, setExpression] = useState<Expression>('happy');
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [offers, setOffers] = useState<PetAction[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [errorPhase, setErrorPhase] = useState<'start' | 'send' | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>('idle');
  const [drafting, setDrafting] = useState(false);
  const [voiceError, setVoiceError] = useState<VoiceFailure | null>(null);
  const [voiceCaption, setVoiceCaption] = useState('');
  const [speechUnavailable, setSpeechUnavailable] = useState(false);
  const [sessions, setSessions] = useState<SessionsRes['items']>([]);
  const [sessionAction, setSessionAction] = useState<string | null>(null);
  const [pendingReview, setPendingReview] = useState<PendingReview | null>(null);
  const pendingMessageId = pendingReview?.messageId;
  const [retryTarget, setRetryTarget] = useState<RetryTarget | null>(null);
  const [safetyChecking, setSafetyChecking] = useState(true);
  const [safetyError, setSafetyError] = useState<unknown>(null);
  const [safetyAttempt, setSafetyAttempt] = useState(0);
  const pendingReviewRef = useRef<PendingReview | null>(null);
  const safetyEpoch = useRef(0);
  const safetyAbort = useRef<AbortController | null>(null);
  const spokenRef = useRef(new Set<string>());
  const voiceRef = useRef<VoiceClient | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingHelpRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancelSend = useCallback(() => {
    ++safetyEpoch.current;
    safetyAbort.current?.abort();
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus('idle');
    setQuickReplies([]);
    setOffers([]);
    setMessages((items) =>
      items.map((item) => (item.streaming ? { ...item, streaming: false } : item)),
    );
  }, []);

  const refreshSessions = useCallback(() => {
    return childRequest<SessionsRes>('/v1/child/chat/sessions')
      .then((result) => setSessions(result.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setErrorPhase(null);
    const start = async () => {
      let saved: { sessionId: string } | null = null;
      try {
        const raw = childId ? sessionStorage.getItem(`mamori-chat-session:${childId}`) : null;
        if (raw) saved = JSON.parse(raw);
      } catch {
        // Session recovery is optional when browser storage is unavailable.
      }
      if (saved?.sessionId) {
        try {
          const history = await childRequest<MessagesRes>(
            `/v1/child/chat/sessions/${encodeURIComponent(saved.sessionId)}/messages`,
          );
          if (cancelled) return;
          setSessionId(saved.sessionId);
          setMessages(
            history.items.map((item) => ({ id: item.messageId, role: item.role, text: item.text })),
          );
          void refreshSessions();
          return;
        } catch (err) {
          if (!(err instanceof ChildApiError) || err.code !== 'NOT_FOUND') throw err;
          try {
            sessionStorage.removeItem(`mamori-chat-session:${childId}`);
          } catch {
            /* optional storage */
          }
        }
      }
      const s = await client.startSession();
      if (cancelled) return;
      setSessionId(s.sessionId);
      setMessages([{ id: 'open', role: 'pet', text: s.openingMessage, readAloud: true }]);
      void refreshSessions();
    };
    void start().catch((err) => {
      if (!cancelled) {
        setError(err);
        setErrorPhase('start');
      }
    });
    return () => {
      cancelled = true;
      ++safetyEpoch.current;
      safetyAbort.current?.abort();
      abortRef.current?.abort();
      abortRef.current = null;
      voiceRef.current?.stop();
      window.speechSynthesis?.cancel();
    };
  }, [childId, client, refreshSessions, startAttempt]);

  useEffect(() => {
    if (!childId || !sessionId) return;
    try {
      sessionStorage.setItem(`mamori-chat-session:${childId}`, JSON.stringify({ sessionId }));
    } catch {
      // Store only IDs, never message text or authenticated responses.
    }
  }, [childId, sessionId]);

  const resetSafety = useCallback(() => {
    ++safetyEpoch.current;
    safetyAbort.current?.abort();
    pendingReviewRef.current = null;
    setPendingReview(null);
    setRetryTarget(null);
    setSafetyError(null);
    setSafetyChecking(true);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      setSessionAction(id);
      try {
        await childRequest<void>(`/v1/child/chat/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (id === sessionId) {
          cancelSend();
          resetSafety();
          try {
            sessionStorage.removeItem(`mamori-chat-session:${childId}`);
          } catch {
            /* optional storage */
          }
          setSessionId(null);
          setMessages([]);
          setStartAttempt((value) => value + 1);
        }
        await refreshSessions();
      } catch (err) {
        setError(err);
        setErrorPhase('send');
      } finally {
        setSessionAction(null);
      }
    },
    [cancelSend, childId, refreshSessions, resetSafety, sessionId],
  );

  const openSession = useCallback(
    async (id: string) => {
      if (id === sessionId || sessionAction) return;
      setSessionAction(`open:${id}`);
      setError(null);
      setErrorPhase(null);
      cancelSend();
      voiceRef.current?.stop();
      window.speechSynthesis?.cancel();
      try {
        const result = await childRequest<MessagesRes>(
          `/v1/child/chat/sessions/${encodeURIComponent(id)}/messages`,
        );
        resetSafety();
        setSessionId(id);
        setMessages(
          result.items.map((item) => ({
            id: item.messageId,
            role: item.role,
            text: item.text,
            readAloud: item.role === 'pet',
          })),
        );
        setQuickReplies([]);
        setOffers([]);
      } catch (err) {
        setError(err);
        setErrorPhase('send');
      } finally {
        setSessionAction(null);
      }
    },
    [cancelSend, resetSafety, sessionAction, sessionId],
  );

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
    if (pendingMessageId) {
      pendingHelpRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, quickReplies, offers, pendingMessageId, retryTarget]);

  const handleCrisis = useCallback(
    (payload: CrisisPayload) => {
      ++safetyEpoch.current;
      safetyAbort.current?.abort();
      abortRef.current?.abort();
      voiceRef.current?.stop();
      window.speechSynthesis?.cancel();
      saveCrisis(payload);
      router.replace('/safe');
    },
    [router],
  );

  useEffect(() => {
    if (!sessionId || sessionAction || abortRef.current) return;
    const epoch = ++safetyEpoch.current;
    const controller = new AbortController();
    safetyAbort.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => safetyEpoch.current === epoch && !controller.signal.aborted;
    const check = async () => {
      if (!current() || abortRef.current) return;
      try {
        const result = await childRequest<ChatSafetyRes>(
          `/v1/child/chat/sessions/${encodeURIComponent(sessionId)}/safety`,
          { signal: controller.signal },
        );
        if (!current()) return;
        setSafetyError(null);
        if (result.status === 'crisis') {
          handleCrisis(result.crisis);
          return;
        }
        if (result.status === 'pending_review') {
          pendingReviewRef.current = result;
          setPendingReview(result);
          setRetryTarget(null);
          voiceRef.current?.stop();
          window.speechSynthesis?.cancel();
        } else {
          const previous = pendingReviewRef.current;
          setRetryTarget(
            result.resumeMessageId
              ? { messageId: result.resumeMessageId, reason: previous ? 'review' : 'fallback' }
              : null,
          );
          pendingReviewRef.current = null;
          setPendingReview(null);
        }
        setSafetyChecking(false);
      } catch (err) {
        if (!current()) return;
        setSafetyError(err);
      }
      if (current() && pendingReviewRef.current) timer = setTimeout(() => void check(), 3000);
    };
    if (pendingReviewRef.current) timer = setTimeout(() => void check(), 3000);
    else void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [sessionId, sessionAction, safetyAttempt, handleCrisis]);

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
    if (!sessionId || sessionAction || pendingReview || safetyChecking || status !== 'idle') return;
    setVoiceError(null);
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
      onError: setVoiceError,
    });
    voiceRef.current = voice;
    void voice.start();
  };

  const send = useCallback(
    (
      text: string,
      typing?: TypingMetrics,
      inputMode: 'typed' | 'quick_reply' = 'typed',
      retry?: RetryTarget,
    ) => {
      if (
        !sessionId ||
        sessionAction ||
        pendingReview ||
        safetyChecking ||
        status !== 'idle' ||
        voiceStatus !== 'idle'
      )
        return;
      if (retry && !client.retry) return;
      // Safety snapshots from before this turn must not overwrite its streamed outcome.
      ++safetyEpoch.current;
      safetyAbort.current?.abort();
      setError(null);
      setErrorPhase(null);
      setRetryTarget(null);
      if (!retry) {
        setQuickReplies([]);
        setOffers([]);
      }
      setStatus('sending');
      const childMessageId = crypto.randomUUID();
      const petId = crypto.randomUUID();
      if (!retry) setMessages((m) => [...m, { id: childMessageId, role: 'child', text }]);
      const controller = new AbortController();
      abortRef.current = controller;
      const isCurrentRequest = () => abortRef.current === controller && !controller.signal.aborted;
      let storedMessageId = retry?.messageId;
      const finishReply = () =>
        setMessages((items) =>
          items.flatMap((item) =>
            item.id !== petId ? [item] : item.text ? [{ ...item, streaming: false }] : [],
          ),
        );
      const req = {
        text,
        inputMode,
        clientSentAt: new Date().toISOString(),
        ...(typing && dataSources.typing ? { typing } : {}),
      };
      const sendFailed = (reason: unknown = 'send') => {
        if (!isCurrentRequest()) return;
        abortRef.current = null;
        finishReply();
        setError(reason);
        setErrorPhase('send');
        setRetryTarget(null);
        setStatus('idle');
        // A lost response does not mean the server skipped this turn; recover eligibility first.
        setSafetyChecking(true);
        setSafetyAttempt((value) => value + 1);
      };
      const handlers: ChatEventHandlers = {
        onMeta: (messageId) => {
          if (!isCurrentRequest()) return;
          storedMessageId = messageId;
          setStatus('streaming');
          setMessages((m) =>
            m.some((item) => item.id === petId)
              ? m
              : [...m, { id: petId, role: 'pet', text: '', streaming: true, readAloud: true }],
          );
        },
        onDelta: (delta) => {
          if (!isCurrentRequest()) return;
          setMessages((m) => m.map((x) => (x.id === petId ? { ...x, text: x.text + delta } : x)));
        },
        onAction: (action) => {
          if (isCurrentRequest()) onAction(action);
        },
        // Crisis events remain global even after a session change.
        onCrisis: handleCrisis,
        onReview: (pending) => {
          if (!isCurrentRequest()) return;
          abortRef.current = null;
          ++safetyEpoch.current;
          safetyAbort.current?.abort();
          pendingReviewRef.current = pending;
          setPendingReview(pending);
          setRetryTarget(null);
          setSafetyChecking(false);
          setSafetyError(null);
          setSafetyAttempt((value) => value + 1);
          voiceRef.current?.stop();
          window.speechSynthesis?.cancel();
          finishReply();
          setStatus('idle');
        },
        onDone: (_replyId, retryable) => {
          if (!isCurrentRequest()) return;
          abortRef.current = null;
          finishReply();
          setRetryTarget(
            retryable === true && storedMessageId
              ? { messageId: storedMessageId, reason: 'fallback' }
              : null,
          );
          setStatus('idle');
          setErrorPhase(null);
        },
        onError: sendFailed,
      };
      const request = retry
        ? client.retry!(sessionId, retry.messageId, handlers, controller.signal)
        : client.send(sessionId, req, handlers, controller.signal);
      void request.catch(sendFailed);
    },
    [
      client,
      sessionId,
      sessionAction,
      status,
      voiceStatus,
      pendingReview,
      safetyChecking,
      dataSources.typing,
      handleCrisis,
      onAction,
    ],
  );

  return (
    <div
      className="mx-auto flex h-full min-h-0 w-full max-w-md flex-col"
      data-testid="chat-panel"
      data-status={status}
    >
      <div ref={listRef} data-testid="chat-scroll" className="min-h-0 flex-1 overflow-y-auto">
        <RestReminder className="hidden [html[data-night=true]_&]:flex" />
        <div className="flex shrink-0 items-center gap-3 px-4 pb-2">
          <div key={expression} className="animate-pop">
            <PetAvatar
              characterId={characterId ?? 'moko'}
              expression={expression}
              state={drafting || voiceStatus === 'listening' ? 'listen' : 'attend'}
              size={56}
            />
          </div>
          <p className="text-sm text-ink-soft" aria-live="polite">
            {status === 'sending' ? copy.thinking : ''}
          </p>
        </div>

        <details className="mx-4 mb-2 rounded-xl border border-ink/10 bg-white/55 px-3 py-2">
          <summary className="cursor-pointer text-sm font-bold" data-testid="session-manager">
            おはなしの記録
          </summary>
          <div className="mt-2 space-y-2" data-testid="session-list">
            {sessions.length === 0 ? (
              <p className="text-xs text-ink-soft">まだ記録はありません。</p>
            ) : (
              sessions.map((item) => (
                <div
                  key={item.sessionId}
                  className="flex items-center justify-between gap-2 text-xs"
                >
                  <span className="truncate text-ink-soft">
                    {new Date(item.startedAt).toLocaleString('ja-JP', {
                      month: 'numeric',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                    {item.sessionId === sessionId ? '（いま）' : ''}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 font-bold text-ink-soft hover:bg-cream-deep disabled:opacity-50"
                      data-testid={`open-session-${item.sessionId}`}
                      disabled={sessionAction !== null || item.sessionId === sessionId}
                      onClick={() => void openSession(item.sessionId)}
                    >
                      {sessionAction === `open:${item.sessionId}` ? 'よみこみ中' : 'ひらく'}
                    </button>
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 font-bold text-ink-soft hover:bg-cream-deep disabled:opacity-50"
                      data-testid={`delete-session-${item.sessionId}`}
                      disabled={sessionAction !== null}
                      onClick={() => void deleteSession(item.sessionId)}
                    >
                      {sessionAction === item.sessionId ? '整理中' : 'けす'}
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        </details>

        <div className="space-y-3 px-4 py-2" role="log" aria-live="polite">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.role === 'child' ? 'justify-end' : 'justify-start'}`}
            >
              <SpeechBubble
                tone={m.role === 'child' ? 'child' : 'pet'}
                tail={m.role === 'child' ? 'right' : 'left'}
              >
                <span data-testid={`msg-${m.role}`}>
                  <FuriganaText text={m.text} enabled={gradeBand === 'low'} />
                </span>
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
                <div className="max-w-full space-y-2">
                  {o.openingLine && (
                    <div className="border-l-2 border-calm/40 pl-3">
                      <p className="mb-1 text-sm text-ink/70">ことばの れい</p>
                      <blockquote data-testid="help-opening-line">
                        <FuriganaText text={o.openingLine} enabled={gradeBand === 'low'} />
                      </blockquote>
                    </div>
                  )}
                  <Link href={`/tell?consultationId=${o.consultationId}`}>
                    <Button variant="calm" data-testid="offer-tell-adult">
                      🤝 {COPY[gradeBand].shelf.tell}
                    </Button>
                  </Link>
                </div>
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
          {pendingReview && (
            <div ref={pendingHelpRef}>
              <PendingReviewHelp pending={pendingReview} />
            </div>
          )}
          {safetyChecking && !pendingReview && sessionId && (
            <p role="status" data-testid="safety-checking" className="text-sm text-ink-soft">
              おはなしを かくにんしているよ。
            </p>
          )}
          {safetyError !== null && (
            <div role="alert" className="space-y-2 text-sm text-ink-soft">
              <p>まだ つながらないよ。たすけてくれる ところは いつでも みられるよ。</p>
              <Button
                variant="secondary"
                data-testid="safety-retry"
                onClick={() => setSafetyAttempt((value) => value + 1)}
              >
                もういちど かくにんする
              </Button>
              <Link href="/help" className="block font-bold underline">
                たすけてくれる ところを みる
              </Link>
            </div>
          )}
          {retryTarget && !pendingReview && !safetyChecking && client.retry && (
            <Button
              variant="secondary"
              data-testid={retryTarget.reason === 'review' ? 'chat-continue' : 'chat-retry'}
              disabled={sessionAction !== null || status !== 'idle' || voiceStatus !== 'idle'}
              onClick={() => send('', undefined, 'typed', retryTarget)}
            >
              {retryTarget.reason === 'review' ? 'この おはなしを つづける' : 'へんじを もういちど'}
            </Button>
          )}
          {error !== null && error !== undefined && (
            <div
              role="alert"
              className="space-y-2 rounded-xl bg-cream-deep p-3 text-sm text-ink-soft"
            >
              <p>
                {error instanceof ChildApiError ? errorMessage(error) : COPY[gradeBand].offline}
              </p>
              {errorPhase === 'start' && (
                <Button variant="secondary" onClick={() => setStartAttempt((n) => n + 1)}>
                  もういちど
                </Button>
              )}
              {error instanceof ChildApiError && error.code === 'MODEL_UNAVAILABLE' && (
                <Link href="/help" className="font-bold text-ink underline">
                  たすけてくれる ところを みる
                </Link>
              )}
              {error instanceof ChildApiError && error.code === 'DATA_SOURCE_DISABLED' && (
                <Link href="/settings" className="font-bold text-ink underline">
                  せっていを みる
                </Link>
              )}
            </div>
          )}
          {speechUnavailable && (
            <p role="status" data-testid="speech-unavailable" className="text-sm text-ink-soft">
              この端末では 日本語のよみあげが 使えません。
            </p>
          )}
          {voiceError === 'error' && (
            <p role="alert" data-testid="voice-error" className="text-sm text-ink-soft">
              音声に つながりませんでした。マイクの きょかと Google 音声の せっていを
              かくにんしてね。文字では おはなしできます。
            </p>
          )}
          {voiceError === 'limit' && (
            <p role="status" data-testid="voice-limit" className="text-sm text-ink-soft">
              きょうの こえの おはなしは ここまで。もじなら つづけて はなせるよ。
            </p>
          )}
          {voiceError === 'unavailable' && (
            <p role="status" data-testid="voice-unavailable" className="text-sm text-ink-soft">
              いまは こえで はなせないよ。もじで はなしてね。
            </p>
          )}
        </div>
        {quickReplies.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 py-2" data-testid="quick-replies">
            {quickReplies.map((q) => (
              <Button
                key={q}
                variant="secondary"
                size="md"
                disabled={
                  pendingReview !== null ||
                  safetyChecking ||
                  sessionAction !== null ||
                  voiceStatus !== 'idle' ||
                  status !== 'idle'
                }
                onClick={() => send(q, undefined, 'quick_reply')}
              >
                {q}
              </Button>
            ))}
          </div>
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
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2">
          <div className="contents">
            <TypingMetricsInput
              enabled={dataSources.typing}
              disabled={
                pendingReview !== null ||
                safetyChecking ||
                sessionAction !== null ||
                status !== 'idle' ||
                !sessionId ||
                voiceStatus !== 'idle'
              }
              placeholder={copy.placeholder}
              sendLabel={copy.send}
              onSubmit={(t, typing) => send(t, typing)}
              onDraftingChange={setDrafting}
            />
          </div>
          {dataSources.voice && (
            <Button
              variant="secondary"
              size="lg"
              aria-label={voiceStatus === 'idle' ? copy.voice : '音声を おわる'}
              aria-pressed={voiceStatus !== 'idle'}
              data-testid="voice-toggle"
              disabled={
                pendingReview !== null ||
                safetyChecking ||
                !sessionId ||
                sessionAction !== null ||
                status !== 'idle'
              }
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
