// SDK cancellation can lag behind a pending network read; bound the consumer as well.
export async function* abortable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let onAbort: () => void = () => {};
  const stopped = new Promise<{ done: true; value: undefined }>((resolve) => {
    onAbort = () => resolve({ done: true, value: undefined });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    while (!signal.aborted) {
      const next = await Promise.race([iterator.next(), stopped]);
      if (next.done || signal.aborted) break;
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    // Waiting for return() would reintroduce the stalled-read problem. The caller also aborts the SDK.
    void iterator.return?.().catch(() => {});
  }
}
