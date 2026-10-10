import type { PetAction, VoiceServerMessage, VoiceTicketRes } from '@ijime/api-types';
import { ChildApiError, childRequest } from './api';
import { BrowserVoiceAudio, type VoiceAudio } from './voice-audio';

export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'reconnecting';
// limit：その日の音声の分数を使い切った。unavailable：音声が全体で無効化されている
export type VoiceFailure = 'error' | 'limit' | 'unavailable';
export type VoiceHandlers = {
  onStatus: (status: VoiceStatus) => void;
  onChildText: (text: string, final: boolean) => void;
  onPetText: (text: string) => void;
  onAction: (action: PetAction) => void;
  onCrisis: (crisis: Extract<VoiceServerMessage, { type: 'crisis' }>) => void;
  onError: (failure: VoiceFailure) => void;
};
function ticketFailure(error: unknown): VoiceFailure {
  if (!(error instanceof ChildApiError)) return 'error';
  if (error.code === 'RATE_LIMITED') return 'limit';
  if (error.code === 'MODEL_UNAVAILABLE') return 'unavailable';
  return 'error';
}

type Dependencies = {
  ticket: () => Promise<VoiceTicketRes>;
  socket: (url: string) => WebSocket;
  audio: () => VoiceAudio;
};

export class VoiceClient {
  private socket?: WebSocket;
  private audio?: VoiceAudio;
  private stopped = false;
  private ready = false;
  private sessionId?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private reconnects = 0;
  private generation = 0;

  constructor(
    private handlers: VoiceHandlers,
    private deps: Dependencies = {
      ticket: () =>
        childRequest<VoiceTicketRes>('/v1/child/voice/tickets', { method: 'POST', body: '{}' }),
      socket: (url) => new WebSocket(url),
      audio: () => new BrowserVoiceAudio(),
    },
  ) {}

  async start(): Promise<void> {
    this.handlers.onStatus('connecting');
    this.audio = this.deps.audio();
    this.timer = setTimeout(() => this.fail(), 20_000);
    try {
      await this.audio.start((pcm) => {
        if (!this.ready || this.stopped || this.socket?.readyState !== 1) return;
        if (this.socket.bufferedAmount > 64 * 1024) {
          this.fail();
          return;
        }
        this.socket.send(pcm);
      });
      if (!this.stopped) await this.connect();
    } catch (error) {
      if (!this.stopped) this.fail(ticketFailure(error));
    }
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation;
    const ticket = await this.deps.ticket();
    if (this.stopped || generation !== this.generation) return;
    const url = new URL(ticket.wsUrl);
    url.searchParams.set('ticket', ticket.ticket);
    const socket = this.deps.socket(url.toString());
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (this.stopped) return;
      socket.send(
        JSON.stringify({
          type: 'start',
          sampleRateHz: 16000,
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        }),
      );
    };
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (this.stopped || generation !== this.generation) return;
      try {
        if (event.data instanceof ArrayBuffer) {
          if (this.ready) this.audio?.play(event.data);
          return;
        }
        const message = JSON.parse(event.data) as VoiceServerMessage;
        switch (message.type) {
          case 'ready':
            clearTimeout(this.timer);
            this.sessionId = message.sessionId;
            this.ready = true;
            this.handlers.onStatus('listening');
            break;
          case 'child_transcript':
            this.handlers.onChildText(message.text, message.final);
            break;
          case 'pet_transcript':
            this.handlers.onPetText(message.text);
            break;
          case 'action':
            this.handlers.onAction(message.action);
            break;
          case 'interrupted':
            this.audio?.interrupt();
            break;
          case 'crisis':
            this.stop();
            this.handlers.onCrisis(message);
            break;
          case 'end':
            if (
              message.reason === 'error' ||
              message.reason === 'limit' ||
              message.reason === 'unavailable'
            )
              this.fail(message.reason);
            else this.stop();
            break;
          default:
            this.fail();
        }
      } catch {
        this.fail();
      }
    };
    socket.onerror = () => this.fail();
    socket.onclose = () => {
      if (this.stopped || generation !== this.generation) return;
      this.ready = false;
      this.audio?.interrupt();
      if (!this.sessionId || this.reconnects++ >= 1) {
        this.fail();
        return;
      }
      this.handlers.onStatus('reconnecting');
      this.timer = setTimeout(() => this.fail(), 5000);
      void this.connect().catch((error: unknown) => this.fail(ticketFailure(error)));
    };
  }

  private fail(failure: VoiceFailure = 'error'): void {
    if (this.stopped) return;
    this.stop();
    this.handlers.onError(failure);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ready = false;
    this.generation++;
    clearTimeout(this.timer);
    this.audio?.close();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.onopen = null;
      if (this.socket.readyState === 1) this.socket.send(JSON.stringify({ type: 'stop' }));
      this.socket.close();
    }
    this.handlers.onStatus('idle');
  }
}
