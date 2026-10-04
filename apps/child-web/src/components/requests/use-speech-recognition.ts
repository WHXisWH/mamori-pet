'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type RecognitionAlternative = { transcript: string };
type RecognitionResult = {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
};
type RecognitionEvent = {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
};
type RecognitionErrorEvent = { error: string };

export type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type RecognitionConstructor = new () => SpeechRecognitionLike;

export type SpeechStatus = 'unknown' | 'unsupported' | 'idle' | 'listening';
export type SpeechError = 'denied' | 'nothing' | null;

function recognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeechRecognition(onFinal: (text: string) => void) {
  const [status, setStatus] = useState<SpeechStatus>('unknown');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<SpeechError>(null);
  const recognizer = useRef<SpeechRecognitionLike | null>(null);
  const finalRef = useRef('');
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    setStatus(recognitionConstructor() ? 'idle' : 'unsupported');
    return () => {
      recognizer.current?.abort();
      recognizer.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    recognizer.current?.stop();
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionConstructor();
    if (!Ctor) {
      setStatus('unsupported');
      return;
    }
    recognizer.current?.abort();
    const rec = new Ctor();
    rec.lang = 'ja-JP';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    finalRef.current = '';
    setInterim('');
    setError(null);
    rec.onresult = (event) => {
      let finals = '';
      let partial = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finals += text;
        else partial += text;
      }
      finalRef.current = finals;
      setInterim(partial);
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed')
        setError('denied');
      else if (event.error === 'no-speech') setError('nothing');
    };
    rec.onend = () => {
      recognizer.current = null;
      setStatus('idle');
      setInterim('');
      const text = finalRef.current.trim();
      if (text) onFinalRef.current(text);
      else setError((prev) => prev ?? 'nothing');
    };
    recognizer.current = rec;
    setStatus('listening');
    try {
      rec.start();
    } catch {
      recognizer.current = null;
      setStatus('idle');
      setError('denied');
    }
  }, []);

  return { status, interim, error, start, stop };
}
