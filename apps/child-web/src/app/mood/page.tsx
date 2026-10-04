'use client';

import type { MoodRes, MoodWeather } from '@ijime/api-types';
import { Button, PetAvatar, SpeechBubble, WEATHER_LABELS, WeatherIcon } from '@ijime/ui';
import { useRouter } from 'next/navigation';
import { useReducer, useState } from 'react';

import { AppShell } from '@/components/AppShell';
import { MoodWeatherPicker } from '@/components/MoodWeatherPicker';
import { RequestError } from '@/components/RequestError';
import { childRequest } from '@/lib/api';
import { COPY } from '@/lib/copy';
import { initialMoodFlow, moodExpression, moodFlow } from '@/lib/mood-flow';
import { todayJst, useChildStore } from '@/lib/store';

export default function MoodPage() {
  const { gradeBand, characterId, todayMood, setMood } = useChildStore();
  const copy = COPY[gradeBand].mood;
  const router = useRouter();
  const [state, dispatch] = useReducer(moodFlow, undefined, () =>
    initialMoodFlow(todayMood, todayJst()),
  );
  const [error, setError] = useState<unknown>(null);
  const label = (w: MoodWeather) => WEATHER_LABELS[w][gradeBand];

  const confirm = async (weather: MoodWeather) => {
    dispatch({ type: 'confirm' });
    setError(null);
    try {
      const result = await childRequest<MoodRes>('/v1/child/mood', {
        method: 'POST',
        body: JSON.stringify({ weather }),
      });
      setMood(weather);
      dispatch({ type: 'sent', reply: result.petReply });
    } catch (err) {
      setError(err);
      dispatch({ type: 'failed' });
    }
  };

  const bubble =
    state.step === 'choosing'
      ? copy.title
      : state.step === 'done'
        ? (state.reply ?? copy.already.replace('{w}', label(state.weather)))
        : copy.picked.replace('{w}', label(state.weather));

  return (
    <AppShell back="/">
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 px-4 py-4">
        <div aria-live="polite" className="w-full">
          <SpeechBubble tail="bottom" className="text-center">
            {bubble}
          </SpeechBubble>
        </div>
        <PetAvatar
          characterId={characterId ?? 'moko'}
          expression={moodExpression(state)}
          size={state.step === 'done' ? 130 : 96}
        />

        {state.step === 'done' ? (
          <div className="flex w-full flex-col items-center gap-4" data-testid="mood-done">
            <div className="flex w-full items-center justify-center gap-4 rounded-card bg-white p-5 shadow-soft">
              <WeatherIcon weather={state.weather} size={64} />
              <div>
                <p className="text-sm text-ink-soft">{copy.today}</p>
                <p className="text-2xl font-bold">{label(state.weather)}</p>
              </div>
            </div>
            <Button className="w-full" onClick={() => router.push('/')}>
              {copy.home}
            </Button>
            <Button variant="ghost" size="md" onClick={() => dispatch({ type: 'again' })}>
              {copy.again}
            </Button>
          </div>
        ) : (
          <>
            <div className="w-full">
              <MoodWeatherPicker
                selected={state.step === 'choosing' ? undefined : state.weather}
                disabled={state.step === 'sending'}
                onPick={(weather) => dispatch({ type: 'pick', weather })}
              />
            </div>
            <RequestError error={error} />
            <Button
              className="w-full"
              data-testid="mood-confirm"
              disabled={state.step !== 'picked'}
              aria-busy={state.step === 'sending'}
              onClick={() => state.step === 'picked' && void confirm(state.weather)}
            >
              {state.step === 'choosing'
                ? copy.pickFirst
                : copy.confirm.replace('{w}', label(state.weather))}
            </Button>
          </>
        )}
      </div>
    </AppShell>
  );
}
