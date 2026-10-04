import { describe, expect, it, vi } from 'vitest';
import { abortable } from './abortable.js';

describe('abortable event stream', () => {
  it('does not advance an already cancelled source', async () => {
    const next = vi.fn(async () => ({ done: false as const, value: 1 }));
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source = { [Symbol.asyncIterator]: () => ({ next, return: close }) };
    const controller = new AbortController();
    controller.abort();
    const stream = abortable(source, controller.signal);
    expect((await stream.next()).done).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not wait on a stuck next or return, and absorbs late rejection', async () => {
    let rejectRead!: (error: Error) => void;
    const close = vi.fn(() => new Promise<IteratorResult<number>>(() => {}));
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<number>>((_resolve, reject) => {
            rejectRead = reject;
          }),
        return: close,
      }),
    };
    const controller = new AbortController();
    const read = abortable(source, controller.signal).next();
    controller.abort();
    expect((await read).done).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    rejectRead(new Error('late read failure'));
    await Promise.resolve();
  });

  it('propagates model failures and releases the source on an early consumer exit', async () => {
    let closed = 0;
    async function* failing() {
      try {
        yield 1;
        throw new Error('model_error');
      } finally {
        closed++;
      }
    }
    const signal = new AbortController().signal;
    const stream = abortable(failing(), signal);
    expect((await stream.next()).value).toBe(1);
    await expect(stream.next()).rejects.toThrow('model_error');
    expect(closed).toBe(1);
    for await (const value of abortable(failing(), signal)) {
      expect(value).toBe(1);
      break;
    }
    expect(closed).toBe(2);
  });
});
