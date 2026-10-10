import type { ChatSafetyRes } from '@ijime/api-types';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { useChildStore } from '@/lib/store';
import { PendingReviewHelp } from './PendingReviewHelp';

afterEach(() => {
  cleanup();
  useChildStore.getState().reset();
});

it('renders exactly the server message and resources, with separate callable emergency numbers', () => {
  useChildStore.setState({ gradeBand: 'high' });
  const pending: Extract<ChatSafetyRes, { status: 'pending_review' }> = {
    status: 'pending_review',
    messageId: 'stored',
    message: 'いまは おはなしを かくにんしているよ。たすけが ほしいときは ここに でんわできるよ。',
    resources: [
      {
        id: 'emergency',
        name: 'すぐに たすけが ひつようなとき',
        audience: 'みんな',
        phone: '110 / 119',
        hours: 'いつでも',
      },
      {
        id: 'family',
        name: 'おうちのことの そうだん',
        audience: 'こども',
        phone: '189',
        url: 'https://example.org/family-help',
      },
    ],
  };
  render(<PendingReviewHelp pending={pending} />);
  expect(screen.getByTestId('pending-review-message').textContent).toBe(pending.message);
  const list = screen.getByTestId('pending-review-resources');
  expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  expect(
    screen.getAllByTestId('pending-review-call').map((link) => link.getAttribute('href')),
  ).toEqual(['tel:110', 'tel:119', 'tel:189']);
  expect(screen.getByRole('link', { name: /警察\s*110 に でんわする/ }).getAttribute('href')).toBe(
    'tel:110',
  );
  expect(
    screen.getByRole('link', { name: /救急・消防\s*119 に でんわする/ }).getAttribute('href'),
  ).toBe('tel:119');
  expect(screen.getByRole('link', { name: 'くわしく みる' }).getAttribute('href')).toBe(
    'https://example.org/family-help',
  );
  for (const resource of pending.resources) {
    expect(screen.getAllByText(resource.name).length).toBeGreaterThan(0);
    expect(screen.getByText(resource.audience)).toBeTruthy();
  }
  expect(screen.getByText('いつでも')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
