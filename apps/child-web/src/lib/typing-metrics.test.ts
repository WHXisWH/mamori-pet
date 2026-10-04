import { describe, expect, it } from 'vitest';

import { TypingMetricsTracker } from './typing-metrics';

describe('TypingMetricsTracker', () => {
  it('counts keys, deletes, compose time and long pauses only', () => {
    let t = 1000;
    const tr = new TypingMetricsTracker(() => t);
    tr.key('char');
    t += 500;
    tr.key('char');
    t += 4000;
    tr.key('delete');
    t += 200;
    tr.key('char');
    t += 300;
    expect(tr.snapshot()).toEqual({
      keyCount: 4,
      deleteCount: 1,
      composeMs: 5000,
      longPauseCount: 1,
    });
  });

  it('ignores deletes during IME composition', () => {
    const tr = new TypingMetricsTracker(() => 0);
    tr.compositionStart();
    tr.key('char');
    tr.key('delete');
    tr.compositionEnd();
    tr.key('delete');
    expect(tr.snapshot().deleteCount).toBe(1);
    expect(tr.snapshot().keyCount).toBe(3);
  });

  it('never stores typed text', () => {
    const tr = new TypingMetricsTracker();
    tr.key('char');
    expect(JSON.stringify(tr)).not.toMatch(/text|value|content/);
    expect(Object.keys(tr.snapshot())).toEqual([
      'keyCount',
      'deleteCount',
      'composeMs',
      'longPauseCount',
    ]);
  });

  it('resets', () => {
    const tr = new TypingMetricsTracker(() => 0);
    tr.key('char');
    tr.reset();
    expect(tr.snapshot()).toEqual({ keyCount: 0, deleteCount: 0, composeMs: 0, longPauseCount: 0 });
  });
});
