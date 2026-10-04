'use client';

import type { CrisisPayload } from '@ijime/api-types';
import { useEffect, useState } from 'react';

import { SafeModeScreen } from '@/components/SafeModeScreen';
import hotlines from '@/generated/hotlines.json';

export default function SafePage() {
  const [payload, setPayload] = useState<CrisisPayload | null>(null);
  const [familyHarm, setFamilyHarm] = useState(false);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('mamori-crisis');
      if (raw) {
        const saved = JSON.parse(raw) as CrisisPayload;
        setPayload(saved);
        // The server sends this resource set only for the family-harm safety route.
        setFamilyHarm(
          saved.resources.some((r) => r.id === 'jidou_soudan') &&
            !saved.resources.some((r) => r.id === 'sos_dial'),
        );
      }
    } catch {
      // ignore
    }
    if (new URLSearchParams(window.location.search).get('family') === '1') setFamilyHarm(true);
  }, []);
  const resources =
    payload && payload.resources.length > 0 ? payload.resources : hotlines.resources;
  return (
    <SafeModeScreen message={payload?.message} resources={resources} familyHarm={familyHarm} />
  );
}
