import type { JapaneseReadingToken } from './furigana';

type Result = JapaneseReadingToken[] | undefined;
let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, (tokens: Result) => void>();

function stopWorker() {
  worker?.terminate();
  worker = undefined;
  for (const settle of pending.values()) settle(undefined);
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker('/reading-worker.js');
  instance.onmessage = ({
    data,
  }: MessageEvent<{ id: number; tokens?: JapaneseReadingToken[] }>) => {
    pending.get(data.id)?.(data.tokens);
  };
  instance.onerror = stopWorker;
  worker = instance;
  return instance;
}

export function readJapanese(text: string, signal: AbortSignal): Promise<Result> {
  if (signal.aborted || typeof Worker === 'undefined') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const id = ++nextId;
    const settle = (tokens: Result) => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      pending.delete(id);
      resolve(tokens);
    };
    const abort = () => settle(undefined);
    const timeout = setTimeout(abort, 30_000);
    pending.set(id, settle);
    signal.addEventListener('abort', abort, { once: true });
    try {
      getWorker().postMessage({ id, text });
    } catch {
      stopWorker();
    }
  });
}
