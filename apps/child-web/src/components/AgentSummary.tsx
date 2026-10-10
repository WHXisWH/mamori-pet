'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AgentSummaryRes } from '@ijime/api-types';
import { Button } from '@ijime/ui';
import { Trash2 } from 'lucide-react';

import { childRequest } from '@/lib/api';
import { useChildStore } from '@/lib/store';
import { FuriganaText } from './FuriganaText';
import { RequestError } from './RequestError';
import { ReadAloudButton } from './requests/ReadAloudButton';

export function AgentSummary({
  disabled = false,
  revision = 0,
}: {
  disabled?: boolean;
  revision?: number;
}) {
  const [summary, setSummary] = useState<AgentSummaryRes['summary']>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const grade = useChildStore((s) => s.gradeBand);
  const load = useCallback(async () => {
    try {
      setError(undefined);
      setSummary((await childRequest<AgentSummaryRes>('/v1/child/agent-summary')).summary);
    } catch (err) {
      setError(err);
    }
  }, []);
  useEffect(() => {
    if (!disabled) void load();
    else setSummary(null);
  }, [disabled, revision, load]);
  async function decide(decision: 'accept' | 'reject') {
    if (!summary) return;
    setBusy(true);
    setError(undefined);
    try {
      await childRequest('/v1/child/agent-summary/decision', {
        method: 'POST',
        body: JSON.stringify({ version: summary.version, decision }),
      });
      if (decision === 'reject') setSummary(null);
      else setSummary({ ...summary, approved: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  if (!summary && !error) return null;
  return (
    <section className="space-y-3 border-t border-cream-deep pt-4" data-testid="agent-summary">
      {summary && (
        <>
          <h2 className="font-bold">
            {summary.approved ? 'おぼえている おはなし' : 'これを おぼえても いい？'}
          </h2>
          <p className="break-words">
            <FuriganaText text={summary.text} enabled={grade === 'low'} />
          </p>
          <ReadAloudButton text={summary.text} />
          <div className="flex flex-wrap gap-2">
            {!summary.approved && (
              <Button
                disabled={busy || disabled}
                onClick={() => void decide('accept')}
                data-testid="summary-accept"
              >
                おぼえていいよ
              </Button>
            )}
            <Button
              variant="secondary"
              disabled={busy || disabled}
              onClick={() => void decide('reject')}
              data-testid="summary-reject"
            >
              {summary.approved ? <Trash2 size={18} aria-label="わすれてね" /> : 'おぼえないで'}
            </Button>
          </div>
        </>
      )}
      <RequestError error={error} retry={() => void load()} />
    </section>
  );
}
