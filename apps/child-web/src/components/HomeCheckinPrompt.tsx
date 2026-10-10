'use client';

import { Button, Card } from '@ijime/ui';
import { useEffect, useState } from 'react';

import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';
import { distanceM, readGeofence } from '@/lib/home-location';
import { ReadAloudButton } from './requests/ReadAloudButton';

export type HomeCheckinResult = { atHome: boolean; method: 'geo' | 'manual' };

export function HomeCheckinPrompt({
  geoEnabled,
  busy = false,
  onDone,
}: {
  geoEnabled: boolean;
  busy?: boolean;
  onDone: (atHome: boolean, method: 'geo' | 'manual') => void;
}) {
  const gradeBand = useChildStore((s) => s.gradeBand);
  const childId = useChildStore((s) => s.childId);
  const copy = COPY[gradeBand].homeCheckin;
  const [mode, setMode] = useState<'checking' | 'manual'>(geoEnabled ? 'checking' : 'manual');

  useEffect(() => {
    if (!geoEnabled || !childId) {
      setMode('manual');
      return;
    }
    const fence = readGeofence(childId);
    if (!fence || !('geolocation' in navigator)) {
      setMode('manual');
      return;
    }
    setMode('checking');
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        setMode('manual');
      }
    }, 6000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const d = distanceM(fence, { lat: pos.coords.latitude, lng: pos.coords.longitude });
        onDone(d <= fence.radiusM, 'geo');
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setMode('manual');
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 5000 },
    );
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [geoEnabled, childId, onDone]);

  return (
    <Card className="mx-4 -mt-4 text-center" data-testid="home-checkin">
      <p className="font-display text-lg font-bold">{copy.ask}</p>
      <ReadAloudButton text={copy.ask} className="mx-auto mt-1" />
      {mode === 'checking' ? (
        <p className="mt-2 text-sm text-ink-soft" aria-busy="true">
          …
        </p>
      ) : (
        <div className="mt-4 flex justify-center gap-3">
          <Button disabled={busy} onClick={() => onDone(true, 'manual')}>
            {copy.manual}
          </Button>
        </div>
      )}
    </Card>
  );
}
