import type { VoiceBackend } from './backend.js';
import { createServiceApp, type ServiceApp } from '@ijime/service-kit';

export const SERVICE_NAME = 'voice-relay';

export function createApp(ready?: () => Promise<unknown>): ServiceApp {
  return createServiceApp({
    name: SERVICE_NAME,
    version: process.env['SERVICE_VERSION'] ?? '0.1.0',
    ...(ready
      ? {
          ready: () =>
            ready().then(
              () => true,
              () => false,
            ),
        }
      : {}),
  });
}

// ランタイムは非同期に初期化する（kb と辞書の読み込み）。初期化が終わる前に来た接続は、準備が整うまで待たせる
export function lazyBackend(backend: Promise<VoiceBackend>): VoiceBackend {
  return {
    redeem: async (ticket) => (await backend).redeem(ticket),
    open: async (owner, start, io) => (await backend).open(owner, start, io),
  };
}
