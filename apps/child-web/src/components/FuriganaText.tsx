'use client';

import { useEffect, useState } from 'react';
import { furiganaSegments, type JapaneseReadingToken } from '@/lib/furigana';
import { readJapanese } from '@/lib/japanese-reader';

export function FuriganaText({ text, enabled }: { text: string; enabled: boolean }) {
  const [result, setResult] = useState<{ text: string; tokens: JapaneseReadingToken[] }>();
  const fallback = furiganaSegments(text, enabled);
  const needsDictionary =
    enabled && fallback.some((s) => !s.reading && /\p{Script=Han}/u.test(s.text));
  useEffect(() => {
    if (!needsDictionary) return;
    const controller = new AbortController();
    // Coalesce SSE fragments; never replace newer text with an older tokenization.
    const timer = setTimeout(() => {
      void readJapanese(text, controller.signal).then((tokens) => {
        if (tokens && !controller.signal.aborted) setResult({ text, tokens });
      });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, needsDictionary]);
  const segments =
    result?.text === text && needsDictionary
      ? furiganaSegments(text, enabled, result.tokens)
      : fallback;
  return (
    <>
      {segments.map((segment, index) =>
        segment.reading ? (
          <ruby key={`${segment.text}-${index}`}>
            {segment.text}
            <rt className="text-[0.55em] font-normal">{segment.reading}</rt>
          </ruby>
        ) : (
          <span key={`${segment.text}-${index}`}>{segment.text}</span>
        ),
      )}
    </>
  );
}
