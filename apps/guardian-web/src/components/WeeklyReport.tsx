'use client';

import type { MoodWeather, WeeklyReportRes } from '@ijime/api-types';
import { Cloud, CloudLightning, CloudRain, RefreshCw, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

import { GuardianApiError, guardianRequest } from '@/lib/api';
import { ApiFailure, control, field } from './GuardianShell';

const weather = [
  { key: 'sunny', label: 'はれ', Icon: Sun, color: 'bg-amber-400', ink: 'text-amber-700' },
  { key: 'cloudy', label: 'くもり', Icon: Cloud, color: 'bg-stone-400', ink: 'text-stone-600' },
  { key: 'rainy', label: 'あめ', Icon: CloudRain, color: 'bg-sky-500', ink: 'text-sky-700' },
  {
    key: 'stormy',
    label: 'あらし',
    Icon: CloudLightning,
    color: 'bg-violet-400',
    ink: 'text-violet-700',
  },
] satisfies { key: MoodWeather; label: string; Icon: typeof Sun; color: string; ink: string }[];

export function WeeklyReport({ childId }: { childId: string }) {
  const [week, setWeek] = useState('');
  const [report, setReport] = useState<WeeklyReportRes | null>(null);
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    setReport(null);
    setMissing(false);
    const query = week ? `?${new URLSearchParams({ week })}` : '';
    void guardianRequest<WeeklyReportRes>(
      `/v1/children/${encodeURIComponent(childId)}/weekly-reports${query}`,
      { signal: abort.signal },
    )
      .then((res) => {
        if (!abort.signal.aborted) setReport(res);
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        if (err instanceof GuardianApiError && err.code === 'NOT_FOUND') setMissing(true);
        else setError(err instanceof Error ? err : new Error('request_failed'));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [childId, week, refresh]);
  return (
    <section
      className="border-y border-ink/15 py-6"
      aria-labelledby="weekly-heading"
      data-testid="weekly-report"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="weekly-heading" className="text-lg font-bold">
          毎週のようす
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="text-sm">
            週{' '}
            <input
              type="week"
              aria-label="週"
              className={`${field} !w-auto max-w-full`}
              value={week || report?.weekId || ''}
              onChange={(e) => setWeek(e.target.value)}
            />
          </label>
          <button
            className={control}
            onClick={() => {
              setWeek('');
              setRefresh((v) => v + 1);
            }}
            disabled={loading}
          >
            <RefreshCw size={16} aria-hidden />
            最新
          </button>
        </div>
      </div>
      {loading ? (
        <p className="py-8 text-sm text-ink/65" aria-busy="true">
          週の記録を読み込み中
        </p>
      ) : error ? (
        <ApiFailure error={error} retry={() => setRefresh((n) => n + 1)} />
      ) : missing ? (
        <p className="py-8 text-sm text-ink/65" data-testid="weekly-empty">
          この週の記録はまだありません。
        </p>
      ) : (
        report && (
          <div className="mt-6" data-testid="weekly-data">
            <p className="mb-5 text-sm text-ink/65">{report.weekId} の記録</p>
            <div className="grid gap-7 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <div>
                <h3 className="mb-4 text-sm font-bold">心の天気</h3>
                <ul className="space-y-3">
                  {weather.map(({ key, label, Icon, color, ink }) => (
                    <li
                      key={key}
                      className="grid grid-cols-[5.5rem_minmax(0,1fr)_2.75rem] items-center gap-3 text-sm"
                    >
                      <span className="flex items-center gap-2">
                        <Icon className={ink} size={18} aria-hidden />
                        {label}
                      </span>
                      <div className="h-2 overflow-hidden rounded-sm bg-ink/5" aria-hidden>
                        <div
                          className={`h-full ${color}`}
                          style={{ width: `${(report.vitality.mood[key] / 7) * 100}%` }}
                        />
                      </div>
                      <span className="text-right tabular-nums" data-testid={`weekly-${key}`}>
                        {report.vitality.mood[key]} 日
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <dl className="grid grid-cols-2 gap-4 self-start border-t border-ink/10 pt-4 md:border-t-0 md:border-l md:pl-6 md:pt-0">
                <div>
                  <dt className="text-sm text-ink/70">利用した日</dt>
                  <dd
                    className="mt-2 text-2xl font-semibold tabular-nums"
                    data-testid="weekly-active-days"
                  >
                    {report.vitality.activeDays}
                    <span className="ml-1 text-sm font-normal">日</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-ink/70">深夜の利用</dt>
                  <dd
                    className="mt-2 text-2xl font-semibold tabular-nums"
                    data-testid="weekly-late-days"
                  >
                    {report.vitality.lateNightDays}
                    <span className="ml-1 text-sm font-normal">日</span>
                  </dd>
                </div>
              </dl>
            </div>
            {report.summaryText && (
              <p
                className="mt-6 border-l-2 border-emerald-600 pl-4 text-sm leading-7 break-words"
                data-testid="weekly-summary"
              >
                {report.summaryText}
              </p>
            )}
          </div>
        )
      )}
    </section>
  );
}
