'use client';

import type { DeviceReq } from '@ijime/api-types';
import { BellRing, Share } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { guardianRequest } from '@/lib/api';
import {
  browserFacts,
  firebaseDriver,
  platformOf,
  pushEnv,
  pushState,
  registerPush,
  type PushState,
  type RegisterResult,
} from '@/lib/push';
import { control } from './GuardianShell';

export function InstallPrompt() {
  return (
    <div className="border-l-2 border-calm pl-3 text-sm leading-6" data-testid="install-prompt">
      <p className="font-bold">iPhone・iPad で通知を受け取るには</p>
      <ol className="mt-1 list-decimal pl-5">
        <li>
          Safari の共有ボタン（
          <Share size={14} className="inline" aria-label="共有" />
          ）を押します
        </li>
        <li>「ホーム画面に追加」を選びます</li>
        <li>ホーム画面のアイコンから開き直し、この画面で通知を許可します</li>
      </ol>
      <p className="mt-1 text-ink/70">緊急のお知らせはメールでも届きます。</p>
    </div>
  );
}

export function InstallHint() {
  const [show, setShow] = useState(false);
  useEffect(() => setShow(pushState(browserFacts()) === 'needs_install'), []);
  if (!show) return null;
  return (
    <section className="mt-6 border-t border-ink/10 py-5">
      <InstallPrompt />
    </section>
  );
}

export function PushRegistration() {
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [result, setResult] = useState<RegisterResult | null>(null);
  const [busy, setBusy] = useState(false);
  const enable = useCallback(async (askPermission: boolean) => {
    setBusy(true);
    const r = await registerPush(
      firebaseDriver(pushEnv()),
      (body: DeviceReq) =>
        guardianRequest('/v1/devices', { method: 'POST', body: JSON.stringify(body) }),
      platformOf(navigator.userAgent, navigator.maxTouchPoints),
      { askPermission },
    );
    setResult(r);
    if (r === 'denied') setState('denied');
    if (r === 'registered') setState('granted');
    setBusy(false);
  }, []);
  useEffect(() => {
    const next = pushState(browserFacts());
    setState(next);
    // FCM tokens rotate; re-register silently once permission is already granted.
    if (next === 'granted') void enable(false);
  }, [enable]);

  if (state === 'loading') return null;
  if (state === 'needs_install') return <InstallPrompt />;
  if (state === 'unconfigured')
    return (
      <p className="text-sm text-ink/65" data-testid="push-unconfigured">
        この環境ではブラウザ通知の受信登録は未設定です。緊急のお知らせはメールで届きます。
      </p>
    );
  if (state === 'unsupported')
    return (
      <p className="text-sm text-ink/65" data-testid="push-unsupported">
        このブラウザは通知に対応していません。緊急のお知らせはメールで届きます。
      </p>
    );
  if (state === 'denied')
    return (
      <div className="text-sm leading-6" data-testid="push-denied">
        <p>この端末では通知がブロックされています。</p>
        <p className="text-ink/70">
          ブラウザのサイト設定で「通知」を「許可」に変えてから、このページを再読み込みしてください。緊急のお知らせはメールでも届きます。
        </p>
      </div>
    );
  return (
    <div className="space-y-2 text-sm" data-testid="push-registration">
      {state === 'prompt' && (
        <p className="leading-6 text-ink/75">
          お子さんに緊急の心配があるとき、この端末にすぐお知らせします。通知には会話の内容は含まれません。
        </p>
      )}
      {result === 'registered' ? (
        <p role="status" className="text-emerald-800" data-testid="push-registered">
          この端末を通知先に登録しました。
        </p>
      ) : (
        <>
          {result === 'failed' && (
            <p role="alert" className="text-alert">
              通知先を登録できませんでした。通信を確認して、もう一度お試しください。
            </p>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => void enable(state === 'prompt')}
            className={control}
            data-testid="push-enable"
          >
            <BellRing size={17} aria-hidden />
            {busy ? '登録中' : 'この端末で通知を受け取る'}
          </button>
        </>
      )}
    </div>
  );
}
