'use client';

import type { ChatSafetyRes } from '@ijime/api-types';
import { Phone } from 'lucide-react';
import { useChildStore } from '@/lib/store';
import { FuriganaText } from './FuriganaText';

export function PendingReviewHelp({
  pending,
}: {
  pending: Extract<ChatSafetyRes, { status: 'pending_review' }>;
}) {
  const low = useChildStore((state) => state.gradeBand === 'low');
  return (
    <section className="space-y-3 border-l-2 border-calm p-3" data-testid="pending-review-help">
      <p role="status" data-testid="pending-review-message">
        <FuriganaText text={pending.message} enabled={low} />
      </p>
      <ul className="space-y-3" data-testid="pending-review-resources">
        {pending.resources.map((resource) => (
          <li key={resource.id} className="space-y-1">
            <p className="font-bold">
              <FuriganaText text={resource.name} enabled={low} />
            </p>
            <p className="text-sm">
              <FuriganaText text={resource.audience} enabled={low} />
            </p>
            {resource.hours && (
              <p className="text-sm">
                <FuriganaText text={resource.hours} enabled={low} />
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {resource.phone
                ?.split('/')
                .map((phone) => phone.trim())
                .filter(Boolean)
                .map((phone) => (
                  <a
                    key={phone}
                    href={`tel:${phone.replace(/[^\d+]/g, '')}`}
                    data-testid="pending-review-call"
                    className="inline-flex min-h-14 flex-col items-center gap-1 rounded-lg border border-calm px-3 py-2 font-bold"
                  >
                    <span className="flex items-center gap-2">
                      <Phone size={18} aria-hidden />
                      <FuriganaText
                        text={
                          resource.id === 'emergency' && phone === '110'
                            ? '警察'
                            : resource.id === 'emergency' && phone === '119'
                              ? '救急・消防'
                              : resource.name
                        }
                        enabled={low}
                      />
                    </span>
                    <span>{phone} に でんわする</span>
                  </a>
                ))}
              {resource.url && (
                <a
                  href={resource.url}
                  className="inline-flex min-h-12 items-center underline"
                  rel="noreferrer"
                >
                  くわしく みる
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
