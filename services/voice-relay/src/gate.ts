import type { PetAction, VoiceServerMessage } from '@ijime/api-types';
import { voice as voiceConfig } from '@ijime/config';

// 音声ゲート。純粋なステートマシン：ネットワークに触れず、時間も計らない。計時と検知はセッション層がイベントとして渡す。
//   listening  検査待ちの子どもの発話がなく、ペットの出力はそのまま通す
//   holding    子どもが話し始めた：最終の文字起こしが完全な検査を通るまで、ペットの出力をすべて保留する
//   releasing  完全な検査を通過：バッファを順に放出し、その後はそのまま通す
//   muted      ペットの出力が出力フィルタールールで止められた：このターンの残りのペット出力をすべて破棄する
//   crisis     危機：以降、ペットの出力は一切出さない
export type GatePhase = 'listening' | 'holding' | 'releasing' | 'muted' | 'crisis';

export type GateInput =
  | { type: 'child_speech' }
  // 子どもの発話の最終文字起こしをキーワード検査にかけた結果
  | { type: 'keyword'; hit: boolean }
  | { type: 'full'; hit: boolean }
  | { type: 'pet_audio'; data: Buffer }
  | { type: 'pet_text'; text: string }
  | { type: 'pet_action'; action: PetAction }
  | { type: 'pet_filtered' }
  | { type: 'interrupted' }
  | { type: 'turn_complete' }
  | { type: 'transcript_timeout' }
  | { type: 'escalate' };

export type GateOutput =
  | { kind: 'audio'; data: Buffer }
  | { kind: 'message'; message: VoiceServerMessage }
  | { kind: 'crisis' }
  | { kind: 'retry' }
  | { kind: 'safe_reply' };

type PetOutput = Extract<GateOutput, { kind: 'audio' } | { kind: 'message' }>;

function petOutput(input: GateInput): PetOutput | null {
  if (input.type === 'pet_audio') return { kind: 'audio', data: input.data };
  if (input.type === 'pet_text')
    return { kind: 'message', message: { type: 'pet_transcript', text: input.text } };
  if (input.type === 'pet_action')
    return { kind: 'message', message: { type: 'action', action: input.action } };
  return null;
}

const INTERRUPTED: GateOutput = { kind: 'message', message: { type: 'interrupted' } };

export class VoiceGate {
  private state: GatePhase = 'listening';
  private buffer: PetOutput[] = [];
  // holding 中：モデルのこのターンは話し終えた / フィルターで止められた
  private turnDone = false;
  private filtered = false;
  private bufferedBytes = 0;
  private waitForSpeech = false;

  constructor(
    private readonly limits = {
      maxBytes: (voiceConfig.outputSampleRateHz * 2 * voiceConfig.transcriptTimeoutMs) / 1000,
      maxOutputs: Math.ceil(voiceConfig.transcriptTimeoutMs / voiceConfig.frameMs) * 4,
    },
  ) {}

  get phase(): GatePhase {
    return this.state;
  }

  dispose(): void {
    this.clearBuffer();
    this.state = 'muted';
    this.waitForSpeech = true;
  }

  step(input: GateInput): GateOutput[] {
    if (this.state === 'crisis') return [];
    if (
      input.type === 'escalate' ||
      ((input.type === 'full' || input.type === 'keyword') && input.hit)
    )
      return this.enterCrisis();

    const out = petOutput(input);
    switch (this.state) {
      case 'listening':
      case 'releasing':
        if (out) return [out];
        if (input.type === 'child_speech') return this.hold();
        if (input.type === 'turn_complete') {
          this.state = 'listening';
          return [];
        }
        if (input.type === 'interrupted') return [INTERRUPTED];
        if (input.type === 'pet_filtered') {
          this.state = 'muted';
          return [INTERRUPTED, { kind: 'safe_reply' }];
        }
        return [];

      case 'muted':
        if (input.type === 'child_speech') return this.hold();
        if (input.type === 'turn_complete' && !this.waitForSpeech) this.state = 'listening';
        if (input.type === 'interrupted') return [INTERRUPTED];
        return [];

      case 'holding':
        if (out) {
          if (!this.filtered) {
            const bytes =
              out.kind === 'audio'
                ? out.data.byteLength
                : Buffer.byteLength(JSON.stringify(out.message));
            if (
              this.buffer.length >= this.limits.maxOutputs ||
              this.bufferedBytes + bytes > this.limits.maxBytes
            )
              return this.muteUntilSpeech();
            this.buffer.push(out);
            this.bufferedBytes += bytes;
          }
          return [];
        }
        switch (input.type) {
          case 'full':
            return this.release();
          case 'child_speech':
            return this.hold();
          case 'turn_complete':
            this.turnDone = true;
            return [];
          case 'pet_filtered':
            this.filtered = true;
            this.clearBuffer();
            return [];
          case 'interrupted':
            this.clearBuffer();
            this.turnDone = false;
            this.filtered = false;
            return [INTERRUPTED];
          case 'transcript_timeout':
            return this.muteUntilSpeech();
          default:
            return [];
        }
    }
  }

  private hold(): GateOutput[] {
    this.state = 'holding';
    this.clearBuffer();
    this.waitForSpeech = false;
    this.turnDone = false;
    this.filtered = false;
    return [];
  }

  private release(): GateOutput[] {
    const flushed: GateOutput[] = this.filtered ? [{ kind: 'safe_reply' }] : this.buffer;
    this.clearBuffer();
    if (this.turnDone) this.state = 'listening';
    else this.state = this.filtered ? 'muted' : 'releasing';
    return flushed;
  }

  private enterCrisis(): GateOutput[] {
    this.state = 'crisis';
    this.clearBuffer();
    return [{ kind: 'crisis' }];
  }

  private clearBuffer(): void {
    this.buffer = [];
    this.bufferedBytes = 0;
  }

  private muteUntilSpeech(): GateOutput[] {
    this.clearBuffer();
    this.state = 'muted';
    this.waitForSpeech = true;
    return [INTERRUPTED, { kind: 'retry' }];
  }
}
