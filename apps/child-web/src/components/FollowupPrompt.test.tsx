import type { FollowupAnswerReq, FollowupAnswerRes } from '@ijime/api-types';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { childRequest } from '@/lib/api';
import { FollowupPrompt } from './FollowupPrompt';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/lib/api', () => ({
  childRequest: vi.fn(),
  ChildApiError: class extends Error {},
  errorMessage: () => 'つながらなかったよ。もういちど ためしてね。',
}));

const pending = {
  items: [{ followupId: 'consultation/c1~2', dueAt: '2026-10-07T00:00:00Z' }],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(childRequest).mockResolvedValueOnce(pending);
});
afterEach(cleanup);

const outcomes: {
  answer: FollowupAnswerReq['answer'];
  button: string;
  result: FollowupAnswerRes;
  message: string;
}[] = [
  {
    answer: 'talked',
    button: 'おとなと はなせた',
    result: { status: 'answered', continuation: 'scheduled', dueAt: '2026-10-09T00:00:00Z' },
    message: 'また こんど、ようすを きくね。はなしたい ときは、いつでも はなせるよ。',
  },
  {
    answer: 'not_now',
    button: 'いまは はなさない',
    result: { status: 'answered', continuation: 'scheduled' },
    message: 'また こんど、ようすを きくね。はなしたい ときは、いつでも はなせるよ。',
  },
  {
    answer: 'not_now',
    button: 'いまは はなさない',
    result: { status: 'answered', continuation: 'paused' },
    message:
      'この おはなしを こちらから きくのは おやすみするね。てつだってほしい ときは、いつでも いってね。',
  },
  {
    answer: 'supported',
    button: '今は もう だいじょうぶ',
    result: { status: 'answered', continuation: 'supported' },
    message:
      'この おはなしを こちらから きくのは おやすみするね。いつもの あそびに もどろう。はなしたくなったら、いつでも いってね。',
  },
  {
    answer: 'need_help',
    button: 'まだ てつだってほしい',
    result: { status: 'answered', continuation: 'help_requested', consultationId: 'c/new' },
    message: 'つぎに どうするか、いっしょに かんがえよう。',
  },
];

it.each(outcomes)(
  'shows the confirmed result for $answer: $message',
  async ({ answer, button, result, message }) => {
    vi.mocked(childRequest).mockResolvedValueOnce(result);
    render(<FollowupPrompt />);
    fireEvent.click(await screen.findByRole('button', { name: button }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(message));
    expect(childRequest).toHaveBeenLastCalledWith(
      '/v1/child/followups/consultation%2Fc1~2/answer',
      {
        method: 'POST',
        body: JSON.stringify({ answer }),
      },
    );
    expect(screen.getByRole('link', { name: 'てつだってほしい' }).getAttribute('href')).toBe(
      '/tell',
    );
    if (result.consultationId) expect(push).toHaveBeenCalledWith('/tell?consultationId=c%2Fnew');
    else expect(push).not.toHaveBeenCalled();
  },
);

it('keeps the original three choices and never answers without a child action', async () => {
  render(<FollowupPrompt />);
  for (const name of [
    'おとなと はなせた',
    'まだ てつだってほしい',
    'いまは はなさない',
    '今は もう だいじょうぶ',
  ])
    expect(await screen.findByRole('button', { name })).toBeTruthy();
  expect(childRequest).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('status')).toBeNull();
});

it('keeps the question on failed save without success or navigation, then allows retry', async () => {
  vi.mocked(childRequest)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ status: 'answered', continuation: 'supported' });
  render(<FollowupPrompt />);
  fireEvent.click(await screen.findByRole('button', { name: '今は もう だいじょうぶ' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('status')).toBeNull();
  expect(push).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '今は もう だいじょうぶ' }));
  await screen.findByRole('status');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not promise a scheduled or stopped followup when an older response omits continuation', async () => {
  vi.mocked(childRequest).mockResolvedValueOnce({ status: 'answered' });
  render(<FollowupPrompt />);
  fireEvent.click(await screen.findByRole('button', { name: 'おとなと はなせた' }));
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toBe('おしえてくれて ありがとう。'),
  );
});

it('does not repeat an answered prompt after reloading when the server has no due followups', async () => {
  vi.mocked(childRequest).mockResolvedValueOnce({ status: 'answered', continuation: 'supported' });
  const view = render(<FollowupPrompt />);
  fireEvent.click(await screen.findByRole('button', { name: '今は もう だいじょうぶ' }));
  await screen.findByRole('status');
  view.unmount();
  vi.mocked(childRequest).mockResolvedValueOnce({ items: [] });
  render(<FollowupPrompt />);
  await waitFor(() => expect(childRequest).toHaveBeenCalledTimes(3));
  expect(screen.queryByTestId('followup-prompt')).toBeNull();
});
