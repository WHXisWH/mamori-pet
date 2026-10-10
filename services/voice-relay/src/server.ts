import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { VoiceServerMessage } from '@ijime/api-types';
import { voice as voiceConfig } from '@ijime/config';
import type { Logger } from '@ijime/service-kit';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';

import { VoiceOpenError, type VoiceBackend } from './backend.js';
import { LiveConnectError, LiveUnavailableError } from './live.js';
import type { VoiceSession } from './session.js';
import type { TicketOwner } from './tickets.js';

export const VOICE_PATH = '/v1/voice';
const FRAME_BYTES = ((voiceConfig.inputSampleRateHz * voiceConfig.frameMs) / 1000) * 2;
// 接続後に start メッセージを待つ制限時間
const START_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;

const clientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    sessionId: z.string().min(1).max(128).optional(),
    sampleRateHz: z.literal(voiceConfig.inputSampleRateHz),
  }),
  z.object({ type: z.literal('stop') }),
]);

// クライアントから届く任意の長さのバイナリフレームを、40ms 固定のフレームに切り直す（発話区切りと特徴計算はフレーム単位で時間を数える）
export class Framer {
  private rest = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    const buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const out: Buffer[] = [];
    let i = 0;
    for (; i + FRAME_BYTES <= buf.length; i += FRAME_BYTES)
      out.push(Buffer.from(buf.subarray(i, i + FRAME_BYTES)));
    this.rest = Buffer.from(buf.subarray(i));
    return out;
  }
}

function reject(socket: Duplex, status: 401 | 403 | 404 | 500): void {
  const text = {
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    500: 'Internal Server Error',
  };
  socket.end(
    `HTTP/1.1 ${status} ${text[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export type VoiceServerOptions = {
  backend: VoiceBackend;
  logger: Logger;
  // 許可するブラウザのオリジン（子ども側）。空のときは検査しない（ローカル開発）
  allowedOrigins?: string[];
};

// HTTP サーバー上で /v1/voice の WebSocket アップグレードを受け持つ。チケットはアップグレード前に消費し、URL には長期トークンを載せない
export function attachVoiceServer(
  server: Server,
  opts: VoiceServerOptions,
): { closeAll: () => Promise<void> } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const live = new Set<VoiceSession>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== VOICE_PATH) return reject(socket, 404);
    const origin = req.headers.origin;
    if (opts.allowedOrigins?.length && (!origin || !opts.allowedOrigins.includes(origin)))
      return reject(socket, 403);
    opts.backend.redeem(url.searchParams.get('ticket') ?? '').then(
      (owner) => {
        if (!owner) return reject(socket, 401);
        wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, owner));
      },
      () => {
        opts.logger.error('voice.redeem_failed', {
          code: 'ticket_lookup_failed',
        });
        reject(socket, 500);
      },
    );
  });

  function onConnection(ws: WebSocket, owner: TicketOwner): void {
    const framer = new Framer();
    let session: VoiceSession | undefined;
    let starting = false;
    const send = (m: VoiceServerMessage | Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Buffer.isBuffer(m)) ws.send(m, { binary: true });
      else ws.send(JSON.stringify(m));
    };
    const closeSocket = () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.close(1000);
    };
    const fail = (reason: 'error' | 'limit' | 'unavailable' = 'error') => {
      send({ type: 'end', reason });
      closeSocket();
    };
    const startTimer = setTimeout(() => fail(), START_TIMEOUT_MS);
    startTimer.unref();

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (session) for (const f of framer.push(toBuffer(data))) session.onAudio(f);
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(toBuffer(data).toString('utf8'));
      } catch {
        return;
      }
      const msg = clientMessage.safeParse(raw);
      if (!msg.success) return;
      if (msg.data.type === 'stop') {
        if (session) void session.stop();
        else closeSocket();
        return;
      }
      if (starting) return;
      starting = true;
      clearTimeout(startTimer);
      const start = msg.data.sessionId ? { sessionId: msg.data.sessionId } : {};
      opts.backend.open(owner, start, { send, closeSocket }).then(
        (opened) => {
          if (ws.readyState !== WebSocket.OPEN || opened.session.isEnded) {
            void opened.session.end('stop');
            void opened.live.close();
            closeSocket();
            return;
          }
          session = opened.session;
          live.add(session);
          send({ type: 'ready', sessionId: opened.sessionId });
          void session.attach(opened.live).then(
            () => live.delete(opened.session),
            () => {
              live.delete(opened.session);
              closeSocket();
            },
          );
          opts.logger.info('voice.session_start', {
            pseudoId: owner.childId,
            sessionId: opened.sessionId,
          });
        },
        (err: unknown) => {
          opts.logger.warn('voice.open_failed', {
            pseudoId: owner.childId,
            reason:
              err instanceof VoiceOpenError
                ? err.reason
                : err instanceof LiveUnavailableError
                  ? err.code
                  : err instanceof LiveConnectError
                    ? 'live_connect'
                    : 'internal',
          });
          const refused = err instanceof VoiceOpenError ? err.reason : undefined;
          fail(
            refused === 'daily_limit'
              ? 'limit'
              : refused === 'voice_disabled'
                ? 'unavailable'
                : 'error',
          );
        },
      );
    });

    ws.on('close', () => {
      clearTimeout(startTimer);
      if (session && !session.isEnded) void session.end('stop');
    });
    ws.on('error', () => closeSocket());
  }

  return {
    closeAll: async () => {
      await Promise.allSettled([...live].map((s) => s.end('error')));
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
