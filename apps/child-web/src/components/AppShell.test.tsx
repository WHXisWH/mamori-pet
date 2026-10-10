import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChildStore } from '@/lib/store';
import { AppShell } from './AppShell';
import { SafeModeScreen } from './SafeModeScreen';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

beforeEach(() => {
  vi.useFakeTimers();
  useChildStore.setState({ gradeBand: 'low', readAloud: true, hydrated: true });
  vi.stubGlobal('speechSynthesis', {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => [{ lang: 'ja-JP', localService: true }],
  });
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      constructor(public text: string) {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useChildStore.getState().reset();
});

describe('the open child shell at JST rest boundaries', () => {
  it.each(['low', 'high', 'jhs'] as const)(
    '%s changes at 23:00, keeps input and help available, and resets at 05:00',
    (gradeBand) => {
      vi.setSystemTime(new Date('2026-10-06T13:59:59.500Z'));
      useChildStore.setState({ gradeBand });
      render(
        <AppShell requireLock={false}>
          <input aria-label="message" />
        </AppShell>,
      );
      const input = screen.getByRole('textbox');
      input.focus();
      fireEvent.change(input, { target: { value: 'draft' } });
      expect(document.documentElement.dataset['night']).toBe('false');
      expect(screen.queryByTestId('rest-reminder')).toBeNull();

      act(() => vi.advanceTimersByTime(500));
      expect(document.documentElement.dataset['night']).toBe('true');
      expect(screen.getByTestId('rest-reminder').textContent).toMatch(/やす|休/);
      expect(screen.getByTestId('help-button').getAttribute('href')).toBe('/help');
      expect(document.activeElement).toBe(input);
      expect((input as HTMLInputElement).value).toBe('draft');
      expect((input as HTMLInputElement).disabled).toBe(false);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(window.speechSynthesis.speak).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(6 * 60 * 60 * 1000));
      expect(document.documentElement.dataset['night']).toBe('false');
      expect(screen.queryByTestId('rest-reminder')).toBeNull();
    },
  );

  it.each(['focus', 'visibilitychange'] as const)(
    'refreshes after a suspended tab resumes (%s)',
    (event) => {
      vi.setSystemTime(new Date('2026-10-06T13:59:00Z'));
      render(<AppShell requireLock={false}>content</AppShell>);
      vi.setSystemTime(new Date('2026-10-06T14:30:00Z'));
      fireEvent(event === 'focus' ? window : document, new Event(event));
      expect(screen.getByTestId('rest-reminder')).toBeTruthy();
      vi.setSystemTime(new Date('2026-10-06T20:10:00Z'));
      fireEvent(event === 'focus' ? window : document, new Event(event));
      expect(screen.queryByTestId('rest-reminder')).toBeNull();
    },
  );

  it('does not put a rest reminder on the help screen', () => {
    vi.setSystemTime(new Date('2026-10-06T14:00:00Z'));
    render(
      <AppShell hideHelp requireLock={false}>
        <a href="tel:189">189</a>
      </AppShell>,
    );
    expect(screen.queryByTestId('rest-reminder')).toBeNull();
    expect(screen.getByRole('link', { name: '189' }).getAttribute('href')).toBe('tel:189');
  });

  it('cleans up the timer before family safety and never automatically reads its text', () => {
    vi.setSystemTime(new Date('2026-10-06T13:59:59Z'));
    const shell = render(<AppShell requireLock={false}>content</AppShell>);
    shell.unmount();
    render(
      <SafeModeScreen
        familyHarm
        resources={[{ id: 'jidou_soudan', name: '児童相談所', audience: 'こども', phone: '189' }]}
      />,
    );
    act(() => vi.advanceTimersByTime(10_000));
    fireEvent.focus(window);
    fireEvent(document, new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    expect(document.documentElement.dataset['night']).toBe('false');
    expect(screen.queryByTestId('rest-reminder')).toBeNull();
    expect(screen.getByTestId('safe-call').getAttribute('href')).toBe('tel:189');
    expect(screen.queryByTestId('adult-yes')).toBeNull();
    expect(window.speechSynthesis.speak).not.toHaveBeenCalled();
  });
});
