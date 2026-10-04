'use client';

import type { MemoryProposalDecisionRes, MemoryProposalsRes } from '@ijime/api-types';
import { Button } from '@ijime/ui';
import { useState } from 'react';
import { childRequest } from '@/lib/api';
import { RequestError } from './RequestError';

export function MemoryProposal({
  proposal,
}: {
  proposal: Pick<MemoryProposalsRes['items'][number], 'proposalId' | 'text' | 'category'>;
}) {
  const [status, setStatus] = useState<'pending' | 'saved' | 'rejected'>('pending');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function decide(decision: 'accept' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      const result = await childRequest<MemoryProposalDecisionRes>(
        `/v1/child/memory-proposals/${encodeURIComponent(proposal.proposalId)}/decision`,
        { method: 'POST', body: JSON.stringify({ decision }) },
      );
      setStatus(result.status);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="w-full rounded-card border border-cream-deep bg-white p-4"
      data-testid="memory-proposal"
      data-status={status}
    >
      {status === 'pending' ? (
        <>
          <p className="font-bold">おぼえても いい？</p>
          <p className="my-2 break-words">{proposal.text}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              data-testid="memory-accept"
              onClick={() => void decide('accept')}
            >
              おぼえていいよ
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              data-testid="memory-reject"
              onClick={() => void decide('reject')}
            >
              おぼえないで
            </Button>
          </div>
          <RequestError error={error} />
        </>
      ) : (
        <p role="status">
          {status === 'saved' ? 'おぼえました。せっていで いつでも けせます。' : 'おぼえません。'}
        </p>
      )}
    </section>
  );
}
