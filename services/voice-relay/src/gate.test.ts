import { describe, expect, it } from 'vitest';

import { VoiceGate, type GateInput, type GateOutput } from './gate.js';

const A = (n: number): GateInput => ({ type: 'pet_audio', data: Buffer.from([n]) });
const T = (text: string): GateInput => ({ type: 'pet_text', text });
const SPEECH: GateInput = { type: 'child_speech' };
const PASS: GateInput = { type: 'full', hit: false };
const KW_HIT: GateInput = { type: 'keyword', hit: true };
const FULL_HIT: GateInput = { type: 'full', hit: true };
const FULL_PASS: GateInput = { type: 'full', hit: false };
const DONE: GateInput = { type: 'turn_complete' };

// 出力を読みやすい記号に縮める：a1 = 音声バイト 1、t:xx = 字幕、i = interrupted
function render(outs: GateOutput[]): string[] {
  return outs.map((o) => {
    if (o.kind === 'audio') return `a${o.data[0]}`;
    if (o.kind === 'message') {
      const m = o.message;
      if (m.type === 'pet_transcript') return `t:${m.text}`;
      if (m.type === 'interrupted') return 'i';
      if (m.type === 'action') return `act:${m.action.type}`;
      return m.type;
    }
    return o.kind;
  });
}

function run(seq: GateInput[]) {
  const gate = new VoiceGate();
  const out = seq.flatMap((s) => gate.step(s));
  return { out: render(out), gate, audioBytes: out.filter((o) => o.kind === 'audio').length };
}

describe('VoiceGate', () => {
  it.each<[string, GateInput[], string[], string]>([
    ['greeting passes while listening', [A(1), T('やあ'), DONE], ['a1', 't:やあ'], 'listening'],
    [
      'holds pet output until the full check passes, then releases in order',
      [SPEECH, A(1), T('うん'), A(2), PASS, A(3), DONE],
      ['a1', 't:うん', 'a2', 'a3'],
      'listening',
    ],
    [
      'releasing straight to listening when the turn already finished',
      [SPEECH, A(1), DONE, PASS, A(9)],
      ['a1', 'a9'],
      'listening',
    ],
    [
      'keyword hit: zero pet bytes',
      [SPEECH, A(1), A(2), KW_HIT, A(3), T('x')],
      ['crisis'],
      'crisis',
    ],
    [
      'full check hits mid-speech: nothing after',
      [SPEECH, A(1), PASS, A(2), FULL_HIT, A(3), DONE, SPEECH, PASS, A(4)],
      ['a1', 'a2', 'crisis'],
      'crisis',
    ],
    [
      'full check pass changes nothing',
      [SPEECH, A(1), PASS, FULL_PASS, A(2)],
      ['a1', 'a2'],
      'releasing',
    ],
    [
      'transcript timeout drops the buffer and asks again',
      [SPEECH, A(1), A(2), { type: 'transcript_timeout' }, A(3)],
      ['i', 'retry'],
      'muted',
    ],
    [
      'escalate_crisis stops everything',
      [A(1), { type: 'escalate' }, A(2)],
      ['a1', 'crisis'],
      'crisis',
    ],
    [
      'interrupted is forwarded while releasing',
      [SPEECH, PASS, A(1), { type: 'interrupted' }],
      ['a1', 'i'],
      'releasing',
    ],
    [
      'interrupted while holding drops what was buffered',
      [SPEECH, A(1), { type: 'interrupted' }, A(2), PASS],
      ['i', 'a2'],
      'releasing',
    ],
    [
      'barge-in during release starts holding again',
      [SPEECH, PASS, A(1), SPEECH, A(2), PASS],
      ['a1', 'a2'],
      'releasing',
    ],
    [
      'filtered while releasing: interrupt, safe reply, mute the rest of the turn',
      [SPEECH, PASS, A(1), { type: 'pet_filtered' }, A(2), T('x'), DONE, A(3)],
      ['a1', 'i', 'safe_reply', 'a3'],
      'listening',
    ],
    [
      'filtered while holding: nothing buffered is released, only the safe reply',
      [SPEECH, A(1), { type: 'pet_filtered' }, A(2), PASS, A(3), DONE],
      ['safe_reply'],
      'listening',
    ],
    [
      'crisis is emitted once',
      [SPEECH, KW_HIT, FULL_HIT, { type: 'escalate' }],
      ['crisis'],
      'crisis',
    ],
  ])('%s', (_name, seq, expected, phase) => {
    const r = run(seq);
    expect(r.out).toEqual(expected);
    expect(r.gate.phase).toBe(phase);
  });

  it('actions are held like audio', () => {
    const r = run([SPEECH, { type: 'pet_action', action: { type: 'show_help_resources' } }, PASS]);
    expect(r.out).toEqual(['act:show_help_resources']);
  });

  it('keyword-only clearance never releases audio', () => {
    const r = run([SPEECH, A(1), { type: 'keyword', hit: false }, A(2)]);
    expect(r.out).toEqual([]);
    expect(r.gate.phase).toBe('holding');
  });

  it('timeout stays muted across late clear and turn-complete, until new speech', () => {
    const r = run([
      SPEECH,
      A(1),
      { type: 'transcript_timeout' },
      PASS,
      DONE,
      A(2),
      SPEECH,
      A(3),
      PASS,
    ]);
    expect(r.out).toEqual(['i', 'retry', 'a3']);
  });

  it.each(['bytes', 'outputs'])('bounds held %s and mutes the remainder of the turn', (limit) => {
    const gate = new VoiceGate({
      maxBytes: limit === 'bytes' ? 1 : 100,
      maxOutputs: limit === 'outputs' ? 1 : 100,
    });
    gate.step(SPEECH);
    expect(gate.step(A(1))).toEqual([]);
    expect(render(gate.step(A(2)))).toEqual(['i', 'retry']);
    expect(gate.phase).toBe('muted');
    for (const ev of [PASS, DONE, A(3)]) expect(gate.step(ev)).toEqual([]);
    gate.step(SPEECH);
    gate.step(A(4));
    expect(render(gate.step(PASS))).toEqual(['a4']);
  });

  it('new speech discards buffered output from the previous unchecked utterance', () => {
    expect(run([SPEECH, A(1), SPEECH, A(2), PASS]).out).toEqual(['a2']);
  });

  // 不変条件 1：どんな順序でも、子どもが話し始めてからキーワード検査を通るまでに届いたペットの音声は、通過前には出力されない
  it('never emits pet audio between child speech and the full result (random sequences)', () => {
    const pool: GateInput[] = [
      SPEECH,
      PASS,
      FULL_PASS,
      DONE,
      A(1),
      T('x'),
      { type: 'interrupted' },
    ];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 500; n++) {
      const gate = new VoiceGate();
      let pendingCheck = false;
      for (let k = 0; k < 30; k++) {
        const ev = pool[Math.floor(rnd() * pool.length)]!;
        const outs = gate.step(ev);
        if (ev.type === 'child_speech') pendingCheck = true;
        if (ev.type === 'full') pendingCheck = false;
        if (pendingCheck) expect(outs.filter((o) => o.kind === 'audio')).toEqual([]);
      }
    }
  });

  // 不変条件 2：ヒットしたあとは、どんな順序でもペットの出力は出ない
  it('emits nothing after crisis (random sequences)', () => {
    const pool: GateInput[] = [SPEECH, PASS, DONE, A(1), T('x'), { type: 'interrupted' }, FULL_HIT];
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 500; n++) {
      const gate = new VoiceGate();
      let crisis = false;
      for (let k = 0; k < 30; k++) {
        const outs = gate.step(pool[Math.floor(rnd() * pool.length)]!);
        if (crisis) expect(outs).toEqual([]);
        if (outs.some((o) => o.kind === 'crisis')) crisis = true;
      }
    }
  });
});
