'use client';

import type { TypingMetrics } from '@ijime/api-types';
import { Button } from '@ijime/ui';
import { useRef, useState, type KeyboardEvent } from 'react';

import { TypingMetricsTracker } from '@/lib/typing-metrics';

export function TypingMetricsInput({
  maxLength = 500,
  enabled,
  disabled = false,
  placeholder,
  sendLabel,
  onSubmit,
}: {
  maxLength?: number;
  enabled: boolean;
  disabled?: boolean;
  placeholder: string;
  sendLabel: string;
  onSubmit: (text: string, typing?: TypingMetrics) => void;
}) {
  const [text, setText] = useState('');
  const tracker = useRef(new TypingMetricsTracker());

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    const metrics = enabled ? tracker.current.snapshot() : undefined;
    onSubmit(t, metrics);
    setText('');
    tracker.current.reset();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Backspace' || e.key === 'Delete') tracker.current.key('delete');
    else if (e.key.length === 1 || e.key === 'Process') tracker.current.key('char');
  };

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor="chat-input">
        {placeholder}
      </label>
      <textarea
        id="chat-input"
        data-testid="chat-input"
        value={text}
        maxLength={maxLength}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        enterKeyHint="send"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => tracker.current.compositionStart()}
        onCompositionEnd={() => tracker.current.compositionEnd()}
        className="grade-tap tap-target col-span-3 min-w-0 resize-none rounded-bubble border-2 border-cream-deep bg-white px-4 py-3 leading-relaxed focus:border-calm focus:outline-none disabled:opacity-60 sm:col-span-1"
      />
      <Button
        type="submit"
        size="lg"
        disabled={disabled || text.trim().length === 0}
        data-testid="chat-send"
        className="col-start-2"
      >
        {sendLabel}
      </Button>
    </form>
  );
}
