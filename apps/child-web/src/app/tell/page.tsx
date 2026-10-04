'use client';

import type {
  ChoiceReq,
  ChoiceRes,
  ConsultationRes,
  ConsultChoice,
  TellAdultRes,
} from '@ijime/api-types';
import { Button } from '@ijime/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { TellAdultFlow, type TellAdultResult } from '@/components/TellAdultFlow';
import { RequestError } from '@/components/RequestError';
import { childRequest, saveCrisis } from '@/lib/api';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';

export default function TellPage() {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const router = useRouter();
  const [consultation, setConsultation] = useState<ConsultationRes | null>(null);
  const [result, setResult] = useState<ConsultChoice | null>(null);
  const [response, setResponse] = useState<ChoiceRes | null>(null);
  const [error, setError] = useState<unknown>(null);
  const creating = useRef<Promise<TellAdultRes> | null>(null);
  const load = useCallback(async () => {
    setError(null);
    setConsultation(null);
    setResult(null);
    setResponse(null);
    try {
      let id = new URLSearchParams(window.location.search).get('consultationId');
      if (!id) {
        creating.current ??= childRequest<TellAdultRes>('/v1/child/tell-adult', {
          method: 'POST',
          body: '{}',
        });
        try {
          const created = await creating.current;
          if (created.crisis) {
            saveCrisis(created.crisis);
            router.push('/safe');
            return;
          }
          if (!created.consultationId) throw new Error('consultation unavailable');
          id = created.consultationId;
        } catch (err) {
          creating.current = null;
          throw err;
        }
        window.history.replaceState(null, '', `/tell?consultationId=${encodeURIComponent(id)}`);
      }
      if (!id) throw new Error('consultation unavailable');
      const current = await childRequest<ConsultationRes>(
        `/v1/child/consultations/${encodeURIComponent(id)}`,
      );
      if (current.crisis) {
        saveCrisis(current.crisis);
        router.push('/safe');
        return;
      }
      setConsultation(current);
      if (current.status === 'answered' && current.choice) {
        setResult(current.choice);
        setResponse({ notificationQueued: current.notificationQueued });
      }
    } catch (err) {
      setError(err);
    }
  }, [router]);
  useEffect(() => {
    void load();
  }, [load]);

  async function choose(value: TellAdultResult): Promise<ChoiceRes> {
    if (!consultation) throw new Error('consultation unavailable');
    const body: ChoiceReq = {
      choice: value.choice,
      ...(value.choice === 'proxy' ? { summary: { text: value.summary, confirmed: true } } : {}),
    };
    const res = await childRequest<ChoiceRes>(
      `/v1/child/consultations/${encodeURIComponent(consultation.consultationId)}/choice`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    setResponse(res);
    if (res.crisis) {
      saveCrisis(res.crisis);
      router.replace('/safe');
    }
    return res;
  }

  return (
    <AppShell back="/">
      <div className="mx-auto max-w-md px-4">
        <RequestError error={error} retry={() => void load()} />
      </div>
      {!consultation && !error && (
        <p className="p-6 text-center" aria-busy="true">
          よみこみ中
        </p>
      )}
      {consultation && !result && <TellAdultFlow onChoose={choose} onFinished={setResult} />}
      {result && (
        <div
          className="mx-auto max-w-md space-y-4 px-4 py-8 text-center"
          data-testid="tell-result"
          data-choice={result}
        >
          <p role="status">
            {response?.notificationQueued
              ? 'おとなへの おしらせを うけつけました。まだ よんだかどうかは わかりません。'
              : result === 'not_now'
                ? COPY[gradeBand].tell.notNow
                : COPY[gradeBand].tell.coachDone}
          </p>
          <Button variant="ghost" onClick={() => router.push('/')}>
            {COPY[gradeBand].back}
          </Button>
        </div>
      )}
    </AppShell>
  );
}
