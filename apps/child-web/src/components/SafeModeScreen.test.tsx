import type { HelpResource } from '@ijime/api-types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChildStore } from '@/lib/store';
import { SafeModeScreen } from './SafeModeScreen';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const resources: HelpResource[] = [
  {
    id: 'sos_dial',
    name: '24時間子供SOSダイヤル',
    audience: '子どもと保護者',
    phone: '0120-0-78310',
  },
  { id: 'childline', name: 'チャイルドライン', audience: '18歳まで', phone: '0120-99-7777' },
  {
    id: 'jidou_soudan',
    name: '児童相談所虐待対応ダイヤル',
    audience: '虐待に関すること',
    phone: '189',
  },
  { id: 'emergency', name: '警察・救急', audience: '緊急の危険があるとき', phone: '110 / 119' },
];

beforeEach(() => useChildStore.setState({ gradeBand: 'high', readAloud: false, hydrated: true }));
afterEach(() => {
  cleanup();
  useChildStore.getState().reset();
});

describe.each(['low', 'high', 'jhs'] as const)('SafeModeScreen for %s', (gradeBand) => {
  it.each([false, true])(
    'keeps original helplines and independently labeled 110/119 before any interaction (family harm: %s)',
    (familyHarm) => {
      useChildStore.setState({ gradeBand });
      render(<SafeModeScreen resources={resources} familyHarm={familyHarm} />);

      const police = screen.getByRole('link', { name: /110/ });
      const emergency = screen.getByRole('link', { name: /119/ });
      expect(police.getAttribute('href')).toBe('tel:110');
      expect(police.textContent).toContain('警察');
      expect(police.textContent).not.toContain('119');
      expect(emergency.getAttribute('href')).toBe('tel:119');
      expect(emergency.textContent).toContain('救急');
      expect(emergency.textContent).not.toContain('110');
      expect(screen.getAllByTestId('safe-call')).toHaveLength(familyHarm ? 3 : 4);

      if (familyHarm) {
        expect(screen.getByRole('link', { name: /189/ }).getAttribute('href')).toBe('tel:189');
        expect(screen.queryByRole('link', { name: /0120/ })).toBeNull();
        expect(screen.queryByTestId('adult-yes')).toBeNull();
        expect(screen.queryByTestId('adult-no')).toBeNull();
      } else {
        expect(screen.getByRole('link', { name: /0120-0-78310/ }).getAttribute('href')).toBe(
          'tel:0120078310',
        );
        expect(screen.getByRole('link', { name: /0120-99-7777/ }).getAttribute('href')).toBe(
          'tel:0120997777',
        );
        expect(screen.queryByRole('link', { name: /189/ })).toBeNull();
        fireEvent.click(screen.getByTestId('adult-no'));
        expect(screen.getByRole('link', { name: /110/ }).getAttribute('href')).toBe('tel:110');
        expect(screen.getByRole('link', { name: /119/ }).getAttribute('href')).toBe('tel:119');
      }
    },
  );
});

describe('leaving the safe screen', () => {
  it('registers the child acknowledgement before going home when family harm is suspected', async () => {
    const onConfirmSafe = vi.fn().mockResolvedValue({ acknowledged: 1 });
    render(<SafeModeScreen resources={resources} familyHarm onConfirmSafe={onConfirmSafe} />);
    fireEvent.click(screen.getByTestId('safe-back'));
    fireEvent.click(screen.getByTestId('safe-confirm-yes'));
    expect(onConfirmSafe).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });

  it('still goes home when the acknowledgement request fails', async () => {
    push.mockClear();
    const onConfirmSafe = vi.fn().mockRejectedValue(new Error('offline'));
    render(<SafeModeScreen resources={resources} familyHarm onConfirmSafe={onConfirmSafe} />);
    fireEvent.click(screen.getByTestId('safe-back'));
    fireEvent.click(screen.getByTestId('safe-confirm-yes'));
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });

  it('goes straight home without an acknowledgement for other crises', () => {
    push.mockClear();
    render(<SafeModeScreen resources={resources} />);
    fireEvent.click(screen.getByTestId('safe-back'));
    fireEvent.click(screen.getByTestId('safe-confirm-yes'));
    expect(push).toHaveBeenCalledWith('/');
  });
});
