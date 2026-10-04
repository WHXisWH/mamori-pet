'use client';

import { AppShell } from '@/components/AppShell';
import { HelpResources } from '@/components/HelpResources';
import { STATIC_HOTLINES } from '@/lib/hotlines-static';

export default function HelpPage() {
  return (
    <AppShell back="/" hideHelp requireLock={false}>
      <HelpResources initial={STATIC_HOTLINES} />
    </AppShell>
  );
}
