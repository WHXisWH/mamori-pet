import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Logger } from '@ijime/service-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { attachVoiceServer } from './server.js';
import { ResumableGemini } from './live.js';

afterEach(() => vi.unstubAllEnvs());

it('Tokyo Live rejection sends only the text-fallback end frame, never ready or audio', async () => {
  vi.stubEnv('ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS', 'false');
  vi.stubEnv('GEMINI_MODEL_PET_VOICE', 'gemini-live-2.5-flash-native-audio');
  const logs: string[] = [];
  const messages: unknown[] = [];
  const server = createServer();
  const voice = attachVoiceServer(server, {
    logger: new Logger('voice-relay', (line) => logs.push(line)),
    backend: {
      redeem: async () => ({ childId: 'synthetic-adult', familyId: 'synthetic-family' }),
      open: async () => {
        new ResumableGemini({ projectId: 'demo-live' });
        throw new Error('unexpected_region_acceptance');
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/voice?ticket=synthetic-ticket`);
      ws.on('error', reject);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'start', sampleRateHz: 16000 })));
      ws.on('message', (data, binary) =>
        messages.push(binary ? 'unexpected-audio' : JSON.parse(String(data))),
      );
      ws.on('close', () => resolve());
    });
    expect(messages).toEqual([{ type: 'end', reason: 'error' }]);
    expect(logs.join('\n')).toContain('live_tokyo_unavailable');
    expect(logs.join('\n')).not.toContain('synthetic-ticket');
  } finally {
    await voice.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('voice error log redaction', () => {
  it.each(['redeem', 'open'])('does not expose provider errors from %s', async (operation) => {
    const sentinel = 'private-child-transcript';
    const logs: string[] = [];
    const server = createServer();
    const voice = attachVoiceServer(server, {
      logger: new Logger('voice-relay', (line) => logs.push(line)),
      backend: {
        redeem: async () => {
          if (operation === 'redeem') throw new Error(sentinel);
          return { childId: 'c1', familyId: 'f1' };
        },
        open: async () => {
          throw new Error(sentinel);
        },
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/voice?ticket=test`);
        ws.on('error', reject);
        ws.on('unexpected-response', (_req, res) => {
          res.resume();
          resolve();
        });
        ws.on('open', () => ws.send(JSON.stringify({ type: 'start', sampleRateHz: 16000 })));
        ws.on('close', () => resolve());
      });
      expect(logs.join('\n')).toContain(`voice.${operation}_failed`);
      expect(logs.join('\n')).not.toContain(sentinel);
      expect(logs.join('\n')).not.toContain('errorMessage');
    } finally {
      await voice.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
