'use client';

import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { childPushState, disableChildPush, enableChildPush, type ChildPushState } from '@/lib/push';

const STATUS: Record<ChildPushState, string> = {
  unconfigured: 'おしらせは まだ じゅんびちゅうです。',
  unsupported:
    'この ブラウザでは おしらせを つかえません。iPhone・iPad は ホームがめんから ひらいてね。',
  denied: 'おしらせは ブラウザで とめられています。',
  off: 'おしらせは オフです。',
  on: 'おしらせは オンです。',
};

export function PushSettings({
  childId,
  disabled = false,
}: {
  childId: string;
  disabled?: boolean;
}) {
  const [state, setState] = useState<ChildPushState>('off');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void childPushState(childId)
      .then(
        (next) => {
          if (active) setState(next);
        },
        () => {
          if (active) setFailed(true);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [childId]);

  const change = (enabled: boolean) => {
    setBusy(true);
    setFailed(false);
    // Do not insert an await before enableChildPush: permission must originate in this gesture.
    const work = enabled ? enableChildPush(childId) : disableChildPush().then(() => 'off' as const);
    void work.then(setState, () => setFailed(true)).finally(() => setBusy(false));
  };
  return (
    <section className="mt-4 border-t border-ink-soft/20 pt-4" data-testid="push-settings">
      <label className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-2">
          <Bell size={18} aria-hidden="true" />
          この たんまつの おしらせ
        </span>
        <input
          type="checkbox"
          className="h-6 w-6 shrink-0 accent-calm"
          checked={state === 'on'}
          disabled={
            disabled ||
            loading ||
            busy ||
            !childId ||
            ['unsupported', 'unconfigured', 'denied'].includes(state)
          }
          onChange={(event) => change(event.target.checked)}
        />
      </label>
      <p className="mt-2 text-sm text-ink-soft" role="status">
        {loading ? 'かくにんちゅう' : STATUS[state]}
      </p>
      {failed && (
        <p className="mt-2 text-sm text-ink-soft" role="alert">
          うまく かえられませんでした。もういちど ためしてね。
        </p>
      )}
    </section>
  );
}
