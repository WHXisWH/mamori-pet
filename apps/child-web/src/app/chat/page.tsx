'use client';

import { AppShell } from '@/components/AppShell';
import { ChatPanel } from '@/components/ChatPanel';

export default function ChatPage() {
  return (
    <AppShell back="/" fillViewport>
      <ChatPanel />
    </AppShell>
  );
}
