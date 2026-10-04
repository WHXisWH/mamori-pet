'use client';

import {
  DATA_SOURCES,
  GRADE_BANDS,
  type ChildPreferencesBody,
  type GradeBand,
  type DataSource,
  type DataSourcesBody,
  type DeletionRes,
  type MemoriesRes,
  type MemoryProposalsRes,
} from '@ijime/api-types';
import { Button, Card, RuleCard } from '@ijime/ui';
import { useCallback, useEffect, useState } from 'react';

import { AppShell } from '@/components/AppShell';
import { PinPad } from '@/components/LockGate';
import { COPY, DATA_SOURCE_LABELS } from '@/lib/copy';
import { useChildStore } from '@/lib/store';
import { childRequest } from '@/lib/api';
import { RequestError } from '@/components/RequestError';
import { MemoryProposal } from '@/components/MemoryProposal';
import { HomeLocationSettings } from '@/components/HomeLocationSettings';
import { clearGeofence } from '@/lib/home-location';

const GRADE_LABELS = {
  low: 'しょうがっこう 1〜3ねん',
  high: '小学校 4〜6年',
  jhs: '中学校',
} as const;

export default function SettingsPage() {
  const s = useChildStore();
  const copy = COPY[s.gradeBand].settings;
  const [lockStep, setLockStep] = useState<'idle' | 'set'>('idle');
  const [deleted, setDeleted] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [memories, setMemories] = useState<MemoriesRes['items']>([]);
  const [proposals, setProposals] = useState<MemoryProposalsRes['items']>([]);
  const [nextPage, setNextPage] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setError(null);
    setLoaded(false);
    try {
      const sources = await childRequest<DataSourcesBody>('/v1/child/data-sources');
      const result = await childRequest<MemoriesRes>('/v1/child/memories');
      const preferences = await childRequest<ChildPreferencesBody>('/v1/child/preferences');
      const pending = await childRequest<MemoryProposalsRes>('/v1/child/memory-proposals');
      for (const key of DATA_SOURCES)
        useChildStore.getState().setDataSource(key, sources.dataSources[key]);
      useChildStore.getState().setGradeBand(preferences.gradeBand);
      useChildStore.getState().setReadAloud(preferences.ttsEnabled ?? false);
      setMemories(result.items);
      setNextPage(result.nextPageToken);
      setProposals(pending.items);
      setLoaded(true);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await childRequest<MemoriesRes>(
        `/v1/child/memories?pageToken=${encodeURIComponent(nextPage ?? '')}`,
      );
      setMemories((current) => [...current, ...result.items]);
      setNextPage(result.nextPageToken);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const changePreferences = async (gradeBand: GradeBand, ttsEnabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await childRequest<ChildPreferencesBody>('/v1/child/preferences', {
        method: 'PUT',
        body: JSON.stringify({ gradeBand, ttsEnabled }),
      });
      s.setGradeBand(result.gradeBand);
      s.setReadAloud(result.ttsEnabled ?? false);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const changeSource = async (key: DataSource, value: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await childRequest<DataSourcesBody>('/v1/child/data-sources', {
        method: 'PUT',
        body: JSON.stringify({ dataSources: { ...s.dataSources, [key]: value } }),
      });
      for (const source of DATA_SOURCES) s.setDataSource(source, result.dataSources[source]);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const deleteMemory = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await childRequest(`/v1/child/memories/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setMemories((items) => items.filter((m) => m.memoryId !== id));
      s.deleteMemory(id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const requestDeletion = async () => {
    setBusy(true);
    setError(null);
    try {
      await childRequest<DeletionRes>('/v1/child/data-deletion-requests', {
        method: 'POST',
        body: '{}',
      });
      setDeleted(true);
      if (s.childId) clearGeofence(s.childId);
      setMemories([]);
      sessionStorage.removeItem('mamori-crisis');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AppShell back="/" title={copy.title}>
      <div className="mx-auto max-w-md space-y-5 px-4 py-3" data-testid="settings">
        <RequestError error={error} retry={() => void load()} />
        <Card>
          <h2 className="font-bold">{copy.grade}</h2>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {GRADE_BANDS.map((g) => (
              <Button
                key={g}
                size="md"
                variant={s.gradeBand === g ? 'primary' : 'secondary'}
                aria-pressed={s.gradeBand === g}
                data-testid={`grade-${g}`}
                disabled={!loaded || busy || deleted}
                onClick={() => void changePreferences(g, s.readAloud)}
              >
                {GRADE_LABELS[g]}
              </Button>
            ))}
          </div>
          <label className="mt-4 flex items-center justify-between">
            <span>{copy.readAloud}</span>
            <input
              type="checkbox"
              className="h-6 w-6 accent-calm"
              checked={s.readAloud}
              disabled={!loaded || busy || deleted}
              onChange={(e) => void changePreferences(s.gradeBand, e.target.checked)}
            />
          </label>
        </Card>

        <Card>
          <h2 className="font-bold">{copy.sources}</h2>
          <ul className="mt-3 space-y-2">
            {DATA_SOURCES.map((k) => (
              <li key={k} className="flex items-center justify-between">
                <span>{DATA_SOURCE_LABELS[s.gradeBand][k]}</span>
                <input
                  type="checkbox"
                  className="h-6 w-6 accent-calm"
                  data-testid={`source-${k}`}
                  checked={s.dataSources[k]}
                  disabled={!loaded || busy || deleted}
                  onChange={(e) => void changeSource(k, e.target.checked)}
                  aria-label={DATA_SOURCE_LABELS[s.gradeBand][k]}
                />
              </li>
            ))}
          </ul>
          <HomeLocationSettings
            childId={s.childId}
            enabled={loaded && !busy && !deleted && s.dataSources.home_checkin}
          />
        </Card>

        <Card>
          <h2 className="font-bold">{copy.memories}</h2>
          {!loaded ? (
            <p aria-busy={!error} className="mt-2 text-sm">
              よみこみ中
            </p>
          ) : memories.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">{copy.noMemories}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {memories.map((m) => (
                <li
                  key={m.memoryId}
                  className="flex items-center justify-between gap-3 rounded-2xl bg-cream px-3 py-2"
                >
                  <span>{m.text}</span>
                  <Button
                    size="md"
                    variant="ghost"
                    disabled={busy || deleted}
                    onClick={() => void deleteMemory(m.memoryId)}
                    aria-label={`${m.text} を消す`}
                  >
                    🗑
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {nextPage && (
            <Button variant="ghost" disabled={busy} onClick={() => void loadMore()}>
              もっと みる
            </Button>
          )}
        </Card>

        {proposals.map((proposal) => (
          <MemoryProposal key={proposal.proposalId} proposal={proposal} />
        ))}
        <RuleCard gradeBand={s.gradeBand} />

        <Card>
          <h2 className="font-bold">{copy.lock}</h2>
          {lockStep === 'idle' ? (
            <div className="mt-3 flex gap-2">
              <Button
                size="md"
                variant="secondary"
                data-testid="lock-set"
                onClick={() => setLockStep('set')}
              >
                {s.petLock ? '🔒 …' : '🔓'}
              </Button>
              {s.petLock && (
                <Button
                  size="md"
                  variant="ghost"
                  data-testid="lock-clear"
                  onClick={() => s.setPetLock(null)}
                >
                  ✕
                </Button>
              )}
            </div>
          ) : (
            <div className="mt-3">
              <PinPad
                label={copy.lock}
                onSubmit={(pin) => {
                  s.setPetLock(pin);
                  setLockStep('idle');
                }}
              />
            </div>
          )}
        </Card>

        <Card className="text-center">
          {deleted ? (
            <p role="status" data-testid="deletion-accepted" className="text-sm text-ink-soft">
              けす おねがいを うけつけました。まだ かんりょうでは ありません。
            </p>
          ) : confirmDelete ? (
            <div className="space-y-3">
              <p>ほんとうに、きろくを けす おねがいを しますか？</p>
              <Button
                variant="danger"
                disabled={busy}
                data-testid="delete-confirm"
                onClick={() => void requestDeletion()}
              >
                おねがいする
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(false)}>
                やめる
              </Button>
            </div>
          ) : (
            <Button
              variant="danger"
              size="md"
              data-testid="delete-all"
              onClick={() => setConfirmDelete(true)}
            >
              {copy.deleteAll}
            </Button>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
