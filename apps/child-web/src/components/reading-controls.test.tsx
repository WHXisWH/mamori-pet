import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RULE_CARD_LINES } from '@ijime/ui';

import SettingsPage from '@/app/settings/page';
import { childRequest } from '@/lib/api';
import { COPY } from '@/lib/copy';
import { useChildStore } from '@/lib/store';
import { AssentStorybook } from './AssentStorybook';
import { CharacterPicker } from './CharacterPicker';
import { ReadAloudButton } from './requests/ReadAloudButton';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('@/lib/api', () => ({ childRequest: vi.fn() }));

const speak = vi.fn();
const localVoice = { lang: 'ja-JP', localService: true } as SpeechSynthesisVoice;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-06T03:00:00Z'));
  useChildStore.setState({ hydrated: true, gradeBand: 'low', readAloud: true, petLock: null });
  vi.stubGlobal('speechSynthesis', { speak, cancel: vi.fn(), getVoices: () => [localVoice] });
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

describe('manual reading controls', () => {
  it.each(['low', 'high', 'jhs'] as const)(
    'respects the reading switch for %s without speaking on mount',
    (gradeBand) => {
      useChildStore.setState({ gradeBand, readAloud: false });
      render(<ReadAloudButton text="学校で話そう。" />);
      expect(screen.queryByTestId('read-aloud')).toBeNull();
      act(() => useChildStore.getState().setReadAloud(true));
      expect(speak).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('read-aloud'));
      expect(speak).toHaveBeenCalledWith(
        expect.objectContaining({ text: '学校で話そう。', voice: localVoice }),
      );
      act(() => useChildStore.getState().setReadAloud(false));
      expect(screen.queryByTestId('read-aloud')).toBeNull();
    },
  );

  it.each(['missing-api', 'no-local-voice'] as const)(
    'keeps static text usable with %s',
    (mode) => {
      vi.stubGlobal(
        'speechSynthesis',
        mode === 'missing-api'
          ? undefined
          : {
              speak,
              cancel: vi.fn(),
              getVoices: () => [{ lang: 'ja-JP', localService: false }],
            },
      );
      render(<AssentStorybook onAgree={vi.fn()} />);
      fireEvent.click(screen.getByTestId('read-aloud'));
      fireEvent.click(screen.getByTestId('assent-next'));
      expect(screen.getByTestId('rule-card')).toBeTruthy();
      expect(speak).not.toHaveBeenCalled();
    },
  );

  it('reads onboarding rules, including the family-safety explanation, only on request', () => {
    render(<AssentStorybook onAgree={vi.fn()} />);
    fireEvent.click(screen.getByTestId('assent-next'));
    expect(speak).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('read-aloud'));
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(RULE_CARD_LINES.low[3]!),
      }),
    );
    fireEvent.click(screen.getByTestId('assent-next'));
    expect(speak).toHaveBeenCalledOnce();
  });

  it('annotates static character text and changes the manual reading when a character is picked', async () => {
    vi.mocked(childRequest).mockResolvedValue({
      items: [
        { characterId: 'moko', locked: false },
        { characterId: 'nami', locked: false },
      ],
    });
    const { container } = render(<CharacterPicker onChoose={vi.fn()} />);
    await waitFor(() =>
      expect((screen.getByTestId('pick-nami') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(container.querySelector('ruby rt')?.textContent).toBe('ききじょうず');
    fireEvent.click(screen.getByTestId('pick-nami'));
    expect(speak).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('read-aloud'));
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('きみが決めていい') }),
    );
  });
});

describe('reading preferences', () => {
  it.each(['low', 'high', 'jhs'] as const)(
    'loads and saves %s reading preferences without changing proactive slots',
    async (gradeBand) => {
      const preferences = {
        gradeBand,
        ttsEnabled: false,
        proactiveEnabled: true,
        proactiveSlots: ['after_school'],
      };
      vi.mocked(childRequest).mockImplementation(async (path, init) => {
        if (path === '/v1/child/data-sources')
          return { dataSources: useChildStore.getState().dataSources };
        if (path === '/v1/child/preferences') {
          if (init?.method === 'PUT') return JSON.parse(String(init.body));
          return preferences;
        }
        return { items: [] };
      });
      render(<SettingsPage />);
      await waitFor(() =>
        expect((screen.getByTestId(`grade-${gradeBand}`) as HTMLButtonElement).disabled).toBe(
          false,
        ),
      );
      const toggle = screen.getByRole('checkbox', {
        name: COPY[gradeBand].settings.readAloud,
      }) as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(screen.queryByTestId('read-aloud')).toBeNull();
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle.checked).toBe(true));
      expect(speak).not.toHaveBeenCalled();
      expect(childRequest).toHaveBeenCalledWith('/v1/child/preferences', {
        method: 'PUT',
        body: JSON.stringify({ ...preferences, ttsEnabled: true }),
      });
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle.checked).toBe(false));
      expect(useChildStore.getState().gradeBand).toBe(gradeBand);
      expect(screen.queryByTestId('read-aloud')).toBeNull();
    },
  );
});
