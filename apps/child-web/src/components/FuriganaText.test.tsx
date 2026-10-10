import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FuriganaText } from './FuriganaText';

class ReadingWorker {
  static instances: ReadingWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  requests: { id: number; text: string }[] = [];
  terminate = vi.fn();
  constructor() {
    ReadingWorker.instances.push(this);
  }
  postMessage(request: { id: number; text: string }) {
    this.requests.push(request);
  }
  reply(index: number, text: string, reading: string) {
    this.onmessage?.({
      data: {
        id: this.requests[index]!.id,
        tokens: [{ surface_form: text, word_type: 'KNOWN', reading }],
      },
    } as MessageEvent);
  }
}

const worker = () => ReadingWorker.instances.at(-1)!;
beforeEach(() => {
  ReadingWorker.instances = [];
  vi.stubGlobal('Worker', ReadingWorker);
});
afterEach(() => {
  cleanup();
  worker()?.onerror?.();
  vi.unstubAllGlobals();
});

describe('dictionary-backed FuriganaText', () => {
  it('annotates dynamic words outside the static UI dictionary', async () => {
    const { container } = render(<FuriganaText text="図書館" enabled />);
    expect(container.textContent).toBe('図書館');
    await waitFor(() => expect(worker()?.requests).toHaveLength(1));
    await act(async () => worker().reply(0, '図書館', 'トショカン'));
    expect(container.querySelector('rt')?.textContent).toBe('としょかん');
  });

  it('ignores a late result for old streaming text and removes readings when disabled', async () => {
    const { container, rerender } = render(<FuriganaText text="図書館" enabled />);
    await waitFor(() => expect(worker()?.requests).toHaveLength(1));
    rerender(<FuriganaText text="運動会" enabled />);
    await waitFor(() => expect(worker()?.requests).toHaveLength(2));
    await act(async () => worker().reply(0, '図書館', 'トショカン'));
    expect(container.textContent).toBe('運動会');
    await act(async () => worker().reply(1, '運動会', 'ウンドウカイ'));
    expect(container.querySelector('rt')?.textContent).toBe('うんどうかい');
    rerender(<FuriganaText text="運動会" enabled={false} />);
    expect(container.textContent).toBe('運動会');
    expect(container.querySelector('ruby')).toBeNull();
  });

  it('preserves the text and fixed safety readings when the dictionary fails', async () => {
    const { container } = render(<FuriganaText text="学校と図書館" enabled />);
    await waitFor(() => expect(worker()?.requests).toHaveLength(1));
    await act(async () => worker().onerror?.());
    expect(container.querySelector('rt')?.textContent).toBe('がっこう');
    expect(container.textContent).toContain('と図書館');
  });

  it('does not load a dictionary for disabled readings or kana-only text', () => {
    render(
      <>
        <FuriganaText text="図書館" enabled={false} />
        <FuriganaText text="こんにちは" enabled />
      </>,
    );
    expect(ReadingWorker.instances).toHaveLength(0);
  });
});
