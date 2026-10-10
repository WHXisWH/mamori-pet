'use client';

import { DATA_SOURCES, type DataSource } from '@ijime/api-types';
import { Button, PetAvatar, RuleCard, RULE_CARD_LINES, RULE_CARD_TITLE } from '@ijime/ui';
import { useState } from 'react';

import { COPY, DATA_SOURCE_LABELS } from '@/lib/copy';
import { DEFAULT_DATA_SOURCES, useChildStore } from '@/lib/store';
import { ReadAloudButton } from './requests/ReadAloudButton';

export function AssentStorybook({
  onAgree,
  busy = false,
}: {
  onAgree: (sources: Record<DataSource, boolean>) => void;
  busy?: boolean;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const copy = COPY[gradeBand].welcome;
  const [page, setPage] = useState(0);
  const [sources, setSources] = useState(DEFAULT_DATA_SOURCES);
  const pages = copy.pages;
  const last = page === pages.length;
  const current = pages[page];
  const readText = last
    ? [
        COPY[gradeBand].settings.sources,
        ...DATA_SOURCES.map((key) => DATA_SOURCE_LABELS[gradeBand][key]),
      ].join('。')
    : page === 1
      ? [RULE_CARD_TITLE[gradeBand], ...RULE_CARD_LINES[gradeBand]].join('\n')
      : `${current?.title ?? ''} ${current?.body ?? ''}`;

  return (
    <div
      className="mx-auto flex max-w-md flex-col items-center gap-5 px-4 py-6"
      data-testid="assent"
      data-page={page}
    >
      <ol className="flex gap-2" aria-label="ページ">
        {[...pages, null].map((_, i) => (
          <li
            key={i}
            className={`h-2 rounded-full transition-all ${i === page ? 'w-8 bg-calm' : 'w-2 bg-calm/30'}`}
          />
        ))}
      </ol>
      {!last && current ? (
        <>
          <PetAvatar characterId="moko" expression={page === 2 ? 'caring' : 'happy'} size={140} />
          {page !== 1 && (
            <h1 className="text-center font-display text-2xl font-bold">{current.title}</h1>
          )}
          {page === 1 ? (
            <RuleCard gradeBand={gradeBand} className="w-full" />
          ) : (
            <p className="text-center text-lg leading-relaxed">{current.body}</p>
          )}
        </>
      ) : (
        <>
          <PetAvatar characterId="moko" expression="together" size={120} />
          <h1 className="text-center font-display text-2xl font-bold">
            {COPY[gradeBand].settings.sources}
          </h1>
          <ul className="w-full space-y-2">
            {DATA_SOURCES.map((k) => (
              <li
                key={k}
                className="flex items-center justify-between rounded-card bg-white px-4 py-3 shadow-soft"
              >
                <span>{DATA_SOURCE_LABELS[gradeBand][k]}</span>
                <input
                  type="checkbox"
                  className="h-6 w-6 accent-calm"
                  checked={sources[k]}
                  disabled={busy}
                  onChange={(e) => setSources((s) => ({ ...s, [k]: e.target.checked }))}
                  aria-label={DATA_SOURCE_LABELS[gradeBand][k]}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <ReadAloudButton text={readText} />
      <Button
        size="xl"
        className="w-full"
        data-testid="assent-next"
        disabled={busy}
        onClick={() => (last ? onAgree(sources) : setPage((p) => p + 1))}
      >
        {last ? copy.agree : copy.next}
      </Button>
    </div>
  );
}
