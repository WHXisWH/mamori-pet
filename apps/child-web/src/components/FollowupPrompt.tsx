'use client';

import type { FollowupAnswerReq, FollowupAnswerRes, FollowupsRes } from '@ijime/api-types';
import { Button } from '@ijime/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { childRequest } from '@/lib/api';
import { RequestError } from './RequestError';

export function FollowupPrompt() {
  const router = useRouter();
  const [items, setItems] = useState<FollowupsRes['items']>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      setItems((await childRequest<FollowupsRes>('/v1/child/followups')).items);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const current = items[0];
  async function answer(answer: FollowupAnswerReq['answer']) {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await childRequest<FollowupAnswerRes>(
        `/v1/child/followups/${encodeURIComponent(current.followupId)}/answer`,
        { method: 'POST', body: JSON.stringify({ answer }) },
      );
      setItems((all) => all.filter((item) => item.followupId !== current.followupId));
      setAnswered(true);
      if (result.consultationId)
        router.push(`/tell?consultationId=${encodeURIComponent(result.consultationId)}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  if (!current && !error && !answered) return null;
  return (
    <section className="mx-auto max-w-md px-4 py-4" data-testid="followup-prompt">
      <RequestError error={error} {...(!current ? { retry: () => void load() } : {})} />
      {current ? (
        <>
          <p className="mb-3 font-bold">このまえの おはなし、そのあと どうだった？</p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              data-testid="followup-talked"
              onClick={() => void answer('talked')}
            >
              おとなと はなせた
            </Button>
            <Button
              disabled={busy}
              variant="calm"
              data-testid="followup-need-help"
              onClick={() => void answer('need_help')}
            >
              まだ てつだってほしい
            </Button>
            <Button
              disabled={busy}
              variant="ghost"
              data-testid="followup-not-now"
              onClick={() => void answer('not_now')}
            >
              いまは はなさない
            </Button>
          </div>
        </>
      ) : (
        answered && <p role="status">おしえてくれて ありがとう。</p>
      )}
    </section>
  );
}
