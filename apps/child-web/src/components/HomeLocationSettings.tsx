'use client';

import { client } from '@ijime/config';
import { Button } from '@ijime/ui';
import { useEffect, useRef, useState } from 'react';
import { clearGeofence, readGeofence, saveGeofence } from '@/lib/home-location';

export function HomeLocationSettings({
  childId,
  enabled,
}: {
  childId: string | null;
  enabled: boolean;
}) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setBusy(false);
    setSaved(childId ? !!readGeofence(childId) : false);
    return () => {
      generation.current += 1;
    };
  }, [childId, enabled]);
  const save = () => {
    if (!childId || !enabled) return;
    setFailed(false);
    if (!navigator.geolocation) {
      setFailed(true);
      return;
    }
    setBusy(true);
    const current = ++generation.current;
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (current !== generation.current) return;
        try {
          saveGeofence(childId, {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            radiusM: client.homeGeofenceDefaultRadiusM,
          });
          setSaved(true);
        } catch {
          setFailed(true);
        }
        setBusy(false);
      },
      () => {
        if (current !== generation.current) return;
        setBusy(false);
        setFailed(true);
      },
      { enableHighAccuracy: false, timeout: 5000, maximumAge: 0 },
    );
  };
  return (
    <div className="mt-4 border-t border-ink/10 pt-4">
      <h3 className="font-bold">おうちの場所</h3>
      <p className="mt-2 text-sm text-ink-soft">
        場所は この端末だけに 保存します。おうちにいるときに 設定してね。
      </p>
      <p role="status" className="mt-2 text-sm" data-testid="home-location-status">
        {saved ? '設定ずみ' : 'まだ設定していません'}
      </p>
      {failed && (
        <p role="alert" className="mt-2 text-sm">
          場所を 保存できませんでした。手動の「ただいま」も使えます。
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="md"
          disabled={!enabled || busy || !childId}
          data-testid="home-location-save"
          onClick={save}
        >
          いまの場所を おうちにする
        </Button>
        {saved && (
          <Button
            size="md"
            variant="secondary"
            disabled={busy}
            data-testid="home-location-clear"
            onClick={() => {
              if (!childId) return;
              try {
                clearGeofence(childId);
                setSaved(false);
                setFailed(false);
              } catch {
                setFailed(true);
              }
            }}
          >
            場所をけす
          </Button>
        )}
      </div>
    </div>
  );
}
