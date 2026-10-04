'use client';

import type {
  ChildHomeRes,
  ChildPreferencesBody,
  DailyRituals,
  DataSourcesBody,
  Expression,
  HomeCheckinRes,
  IslandStateRes,
  PetRequest,
  RitualKind,
} from '@ijime/api-types';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AppShell, SettingsLink } from '@/components/AppShell';
import { FollowupPrompt } from '@/components/FollowupPrompt';
import { HomeCheckinPrompt } from '@/components/HomeCheckinPrompt';
import { GoodThingNote } from '@/components/island/GoodThingJar';
import { IslandScene } from '@/components/island/IslandScene';
import { isBedtime, jstClock, timeOfDay } from '@/components/island/time';
import { PetRequestCard } from '@/components/PetRequestCard';
import { RequestError } from '@/components/RequestError';
import { childRequest, declinePetRequest, fetchIsland, recordRitual } from '@/lib/api';
import { COPY, greetingFor } from '@/lib/copy';
import { todayJst, useChildStore } from '@/lib/store';

export default function HomePage() {
  const { gradeBand, characterId, petName, dataSources, markHomeCheckin } = useChildStore();
  const [expression, setExpression] = useState<Expression>('happy');
  const [greeting, setGreeting] = useState<ChildHomeRes['greeting']>({
    text: '',
    expression: 'happy',
    source: 'template',
  });
  const [showCheckin, setShowCheckin] = useState(false);
  const [clock, setClock] = useState(() => jstClock());
  const [home, setHome] = useState<ChildHomeRes | null>(null);
  const [islandState, setIslandState] = useState<IslandStateRes | null>(null);
  const [rituals, setRituals] = useState<DailyRituals | undefined>(undefined);
  const [goodThingCount, setGoodThingCount] = useState(0);
  const [requests, setRequests] = useState<PetRequest[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [checkinError, setCheckinError] = useState<unknown>(null);
  const [ritualError, setRitualError] = useState<unknown>(null);
  const [checkingIn, setCheckingIn] = useState(false);
  const [ritualBusy, setRitualBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [showGoodThingNote, setShowGoodThingNote] = useState(false);
  const [status, setStatus] = useState('');
  const lastCheckin = useRef<{ atHome: boolean; method: 'geo' | 'manual' } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await childRequest<ChildHomeRes>('/v1/child/home');
      const preferences = await childRequest<ChildPreferencesBody>('/v1/child/preferences');
      const sources = await childRequest<DataSourcesBody>('/v1/child/data-sources');
      const store = useChildStore.getState();
      // 他の画面はローカル store しか読まないため、サーバーの値に合わせる
      store.choosePet(result.pet.characterId, result.pet.petName ?? '', result.pet.hiddenVariantId);
      store.setMood(result.todayMood ?? null);
      store.setGradeBand(preferences.gradeBand);
      store.setReadAloud(preferences.ttsEnabled ?? preferences.gradeBand === 'low');
      for (const source of Object.keys(sources.dataSources) as (keyof typeof sources.dataSources)[])
        store.setDataSource(source, sources.dataSources[source]);
      setHome(result);
      setGreeting(result.greeting);
      setExpression(result.greeting.expression);
      setRituals(result.rituals);
      setRequests(result.petRequests ?? []);
      setShowCheckin(
        result.showHomeCheckin ||
          new URLSearchParams(window.location.search).get('checkin') === '1',
      );
    } catch (err) {
      setError(err);
      return;
    }
    try {
      const island = await fetchIsland();
      setIslandState(island);
      setGoodThingCount(island.goodThingCount);
    } catch {
      setIslandState(null);
    }
  }, []);

  useEffect(() => {
    const now = jstClock();
    setClock(now);
    const schoolDay = now.weekday >= 1 && now.weekday <= 5;
    setGreeting({
      text: greetingFor(gradeBand, now.hour, schoolDay),
      expression: 'happy',
      source: 'template',
    });
    setExpression(now.hour >= 23 || now.hour < 5 ? 'sleepy' : 'happy');
    void load();
  }, [gradeBand, load]);

  const onCheckin = useCallback(
    async (atHome: boolean, method: 'geo' | 'manual') => {
      lastCheckin.current = { atHome, method };
      setCheckingIn(true);
      setCheckinError(null);
      try {
        const result = await childRequest<HomeCheckinRes>('/v1/child/home-checkins', {
          method: 'POST',
          body: JSON.stringify({ atHome, method }),
        });
        markHomeCheckin();
        setShowCheckin(false);
        setGreeting({ text: result.greeting, expression: 'celebrate', source: 'template' });
        setExpression('celebrate');
      } catch (err) {
        setCheckinError(err);
      } finally {
        setCheckingIn(false);
      }
    },
    [markHomeCheckin],
  );

  const ritual = useCallback(
    async (kind: RitualKind) => {
      if (ritualBusy) return;
      const copy = COPY[useChildStore.getState().gradeBand].home;
      setRitualBusy(true);
      setRitualError(null);
      try {
        const result = await recordRitual(kind, todayJst());
        setRituals(result.rituals);
        setGoodThingCount(result.goodThingCount);
        setExpression('celebrate');
        if (kind === 'watered') setStatus(copy.waterDone);
        else {
          setStatus(copy.jarAdded);
          setShowGoodThingNote(true);
        }
      } catch (err) {
        setRitualError(err);
      } finally {
        setRitualBusy(false);
      }
    },
    [ritualBusy],
  );

  const decline = useCallback(async (request: PetRequest) => {
    setDeclining(true);
    setRitualError(null);
    try {
      await declinePetRequest(request.requestId);
      setRequests((all) => all.filter((r) => r.requestId !== request.requestId));
      setStatus(COPY[useChildStore.getState().gradeBand].request.declined);
    } catch (err) {
      setRitualError(err);
    } finally {
      setDeclining(false);
    }
  }, []);

  const copy = COPY[gradeBand];
  const currentRequest = requests[0];
  const bedtime = isBedtime(clock.hour);

  return (
    <AppShell left={<SettingsLink />} requireLock>
      <IslandScene
        island={home?.island}
        todayMood={home?.todayMood}
        timeOfDay={timeOfDay(clock.hour)}
        bedtime={bedtime}
        pet={{
          characterId: home?.pet.characterId ?? characterId ?? 'moko',
          expression,
          ...(petName ? { petName } : {}),
        }}
        greeting={greeting}
        decorations={islandState?.decorations ?? []}
        rituals={rituals}
        goodThingCount={goodThingCount}
        ritualBusy={ritualBusy}
        onWater={() => void ritual('watered')}
        onGoodThing={() => void ritual('good_thing')}
      >
        {petName && (
          <p
            className="absolute bottom-3 left-3 rounded-full bg-white/80 px-3 py-1 text-sm font-bold text-ink-soft"
            data-testid="pet-name"
          >
            {petName}
          </p>
        )}
      </IslandScene>
      <p className="sr-only" role="status" data-testid="home-status">
        {status}
      </p>
      {showCheckin && (
        <HomeCheckinPrompt
          geoEnabled={dataSources.home_checkin}
          busy={checkingIn}
          onDone={onCheckin}
        />
      )}
      <div className="mx-auto max-w-md px-4">
        <RequestError error={error} retry={() => void load()} />
        <RequestError
          error={checkinError}
          retry={() => {
            const previous = lastCheckin.current;
            if (previous) void onCheckin(previous.atHome, previous.method);
          }}
        />
        <RequestError error={ritualError} />
        {home?.pendingConsultation && (
          <Link
            className="block py-3 text-calm-deep underline"
            href={`/tell?consultationId=${encodeURIComponent(home.pendingConsultation.consultationId)}`}
          >
            {copy.home.tell}
          </Link>
        )}
      </div>
      <div className="h-4" />
      <FollowupPrompt />
      {currentRequest && (
        <div className="mx-auto max-w-md pb-2">
          <PetRequestCard
            request={currentRequest}
            busy={declining}
            onDecline={() => void decline(currentRequest)}
          />
        </div>
      )}
      <nav aria-label={copy.home.tell} className="px-4 pt-4 pb-8">
        <p className="text-center">
          <Link
            href="/tell"
            data-testid="tile-tell"
            className="inline-flex min-h-12 items-center gap-2 rounded-full px-4 text-sm font-bold text-ink-soft underline decoration-cream-deep decoration-2 underline-offset-4 hover:text-ink focus-visible:outline-4 focus-visible:outline-calm-deep"
          >
            <span aria-hidden="true">✉️</span>
            {copy.home.tell}
          </Link>
        </p>
      </nav>
      {showGoodThingNote && <GoodThingNote onClose={() => setShowGoodThingNote(false)} />}
    </AppShell>
  );
}
