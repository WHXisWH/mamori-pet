import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';
import { TellAdultFlow } from './TellAdultFlow';

afterEach(cleanup);

// Page translators replace React-owned text nodes with their own markup.
function translateText(text: string) {
  const walker = document.createTreeWalker(screen.getByTestId('tell-adult'), NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent !== text) continue;
    const translated = document.createElement('font');
    translated.textContent = `Translated: ${text}`;
    node.parentNode!.replaceChild(translated, node);
    return;
  }
  throw new Error('Text to translate was not found');
}

describe('TellAdultFlow with translated text', () => {
  it.each(['low', 'high'] as const)(
    'can move between choice and summary for %s grades',
    (gradeBand) => {
      useChildStore.setState({ gradeBand, characterId: 'moko' });
      const copy = COPY[gradeBand].tell;
      render(<TellAdultFlow onChoose={vi.fn()} onFinished={vi.fn()} />);

      for (let i = 0; i < 3; i++) {
        translateText(copy.intro);
        fireEvent.click(screen.getByTestId('choice-proxy'));
        expect(screen.getByTestId('tell-adult').getAttribute('data-step')).toBe('summary');
        expect(screen.getByTestId('summary-input')).toBeTruthy();
        translateText(copy.summaryTitle);
        fireEvent.click(screen.getByRole('button', { name: 'もどる' }));
        expect(screen.getByTestId('tell-adult').getAttribute('data-step')).toBe('choose');
        expect(screen.getByText(copy.intro)).toBeTruthy();
      }
    },
  );

  it('updates translated coaching text and finishes without removing a detached node', async () => {
    useChildStore.setState({ gradeBand: 'high', characterId: 'moko' });
    const copy = COPY.high.tell;
    const coachingScript = ['Practice line one', 'Practice line two'];
    const onChoose = vi.fn().mockResolvedValue({ notificationQueued: false, coachingScript });
    const onFinished = vi.fn();
    render(<TellAdultFlow onChoose={onChoose} onFinished={onFinished} />);

    translateText(copy.intro);
    fireEvent.click(screen.getByTestId('choice-self'));
    await waitFor(() => expect(screen.getByText(coachingScript[0]!)).toBeTruthy());
    for (const line of coachingScript) {
      translateText(line);
      fireEvent.click(screen.getByTestId('coach-next'));
    }
    expect(screen.getByText(copy.coachDone)).toBeTruthy();
    translateText(copy.coachDone);
    fireEvent.click(screen.getByTestId('coach-finish'));
    expect(onChoose).toHaveBeenCalledWith({ choice: 'self' });
    expect(onFinished).toHaveBeenCalledWith('self');
  });
});
