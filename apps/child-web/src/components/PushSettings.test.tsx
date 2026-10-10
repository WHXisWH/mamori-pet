import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { childPushState, disableChildPush, enableChildPush } from '@/lib/push';
import { PushSettings } from './PushSettings';

vi.mock('@/lib/push', () => ({
  childPushState: vi.fn(),
  disableChildPush: vi.fn(),
  enableChildPush: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(childPushState).mockResolvedValue('off');
});
afterEach(cleanup);

it('only starts opt-in on a gesture and reflects confirmed opt-out', async () => {
  vi.mocked(enableChildPush).mockResolvedValue('on');
  vi.mocked(disableChildPush).mockResolvedValue(undefined);
  render(<PushSettings childId="c1" />);
  const toggle = screen.getByRole('checkbox') as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  expect(enableChildPush).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(true));
  expect(enableChildPush).toHaveBeenCalledWith('c1');
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(false));
  expect(disableChildPush).toHaveBeenCalledOnce();
});

it.each(['unconfigured', 'unsupported', 'denied'] as const)(
  'renders the %s state without trying to enable notifications',
  async (state) => {
    vi.mocked(childPushState).mockResolvedValue(state);
    render(<PushSettings childId="c1" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toBe('かくにんちゅう'));
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
    expect(enableChildPush).not.toHaveBeenCalled();
  },
);

it('keeps failed registration visibly off and allows retry', async () => {
  vi.mocked(enableChildPush).mockRejectedValueOnce(new Error('offline')).mockResolvedValue('on');
  render(<PushSettings childId="c1" />);
  const toggle = screen.getByRole('checkbox') as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  await screen.findByRole('alert');
  expect(toggle.checked).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.checked).toBe(true));
});
