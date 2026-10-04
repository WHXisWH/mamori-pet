import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceClient, type VoiceHandlers } from './voice-client';
import type { VoiceAudio } from './voice-audio';

class Socket {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  send = vi.fn<(data: string | ArrayBuffer) => void>();
  close = vi.fn();
  emit(data: object | ArrayBuffer) {
    this.onmessage?.({ data: data instanceof ArrayBuffer ? data : JSON.stringify(data) });
  }
}

function setup() {
  const sockets: Socket[] = [];
  const handlers: VoiceHandlers = {
    onStatus: vi.fn(),
    onChildText: vi.fn(),
    onPetText: vi.fn(),
    onAction: vi.fn(),
    onCrisis: vi.fn(),
    onError: vi.fn(),
  };
  let capture: (data: ArrayBuffer) => void = () => {};
  const audio: VoiceAudio = {
    start: vi.fn(async (fn) => {
      capture = fn;
    }),
    play: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
  };
  const ticket = vi.fn(async () => ({
    ticket: 'single-use',
    wsUrl: 'ws://localhost:8083/v1/voice',
    expiresAt: '2026-10-01T00:00:00Z',
  }));
  const socket = vi.fn((_url: string) => {
    const value = new Socket();
    sockets.push(value);
    return value as unknown as WebSocket;
  });
  const client = new VoiceClient(handlers, { ticket, socket, audio: () => audio });
  return {
    client,
    handlers,
    audio,
    ticket,
    socket,
    sockets,
    capture: (data: ArrayBuffer) => capture(data),
  };
}

afterEach(() => vi.useRealTimers());

describe('voice protocol', () => {
  it('sends the 16 kHz start frame, waits for ready before PCM, and interrupts playback', async () => {
    const s = setup();
    await s.client.start();
    const ws = s.sockets[0]!;
    ws.onopen?.();
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toEqual({
      type: 'start',
      sampleRateHz: 16000,
    });
    expect(s.socket.mock.calls[0]).toEqual(['ws://localhost:8083/v1/voice?ticket=single-use']);
    const pcm = new ArrayBuffer(1280);
    s.capture(pcm);
    expect(ws.send).toHaveBeenCalledTimes(1);
    ws.emit({ type: 'ready', sessionId: 'voice_1' });
    s.capture(pcm);
    expect(ws.send).toHaveBeenLastCalledWith(pcm);
    ws.emit(pcm);
    expect(s.audio.play).toHaveBeenCalledWith(pcm);
    ws.emit({ type: 'interrupted' });
    expect(s.audio.interrupt).toHaveBeenCalledOnce();
    s.client.stop();
    expect(s.audio.close).toHaveBeenCalledOnce();
    expect(ws.close).toHaveBeenCalledOnce();
  });

  it('crisis closes microphone and queue before handing control to the safety UI', async () => {
    const s = setup();
    await s.client.start();
    const ws = s.sockets[0]!;
    ws.emit({ type: 'crisis', message: 'safe copy', resources: [] });
    expect(s.audio.close).toHaveBeenCalledOnce();
    expect(s.handlers.onCrisis).toHaveBeenCalledOnce();
    expect(vi.mocked(s.audio.close).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(s.handlers.onCrisis).mock.invocationCallOrder[0]!,
    );
    ws.emit(new ArrayBuffer(10));
    expect(s.audio.play).not.toHaveBeenCalled();
  });

  it('unconfigured relay and rejected microphone never report listening', async () => {
    const s = setup();
    await s.client.start();
    s.sockets[0]!.emit({ type: 'end', reason: 'error' });
    expect(s.handlers.onStatus).not.toHaveBeenCalledWith('listening');
    expect(s.handlers.onError).toHaveBeenCalledOnce();
    expect(s.audio.close).toHaveBeenCalledOnce();
    const denied = setup();
    vi.mocked(denied.audio.start).mockRejectedValueOnce(new Error('not allowed'));
    await denied.client.start();
    expect(denied.handlers.onError).toHaveBeenCalledOnce();
    expect(denied.ticket).not.toHaveBeenCalled();
  });

  it('does not open a late socket after stop while the ticket is pending', async () => {
    const s = setup();
    let resolve!: (value: Awaited<ReturnType<typeof s.ticket>>) => void;
    s.ticket.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const start = s.client.start();
    await Promise.resolve();
    s.client.stop();
    resolve({ ticket: 'late', wsUrl: 'ws://localhost:8083/v1/voice', expiresAt: '' });
    await start;
    expect(s.socket).not.toHaveBeenCalled();
  });

  it('renews a ticket once on disconnect, resumes only a voice session, and times out', async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.client.start();
    s.sockets[0]!.emit({ type: 'ready', sessionId: 'voice_1' });
    s.sockets[0]!.onclose?.();
    await Promise.resolve();
    const next = s.sockets[1]!;
    next.onopen?.();
    expect(JSON.parse(next.send.mock.calls[0]![0] as string).sessionId).toBe('voice_1');
    expect(s.ticket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.handlers.onError).toHaveBeenCalledOnce();
    expect(s.audio.close).toHaveBeenCalledOnce();
  });

  it('closes on excessive upload backpressure instead of collecting recordings', async () => {
    const s = setup();
    await s.client.start();
    const ws = s.sockets[0]!;
    ws.emit({ type: 'ready', sessionId: 'voice_1' });
    ws.bufferedAmount = 100_000;
    s.capture(new ArrayBuffer(1280));
    expect(s.handlers.onError).toHaveBeenCalledOnce();
    expect(s.audio.close).toHaveBeenCalledOnce();
  });
});
