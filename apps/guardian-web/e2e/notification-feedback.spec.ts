import type { MeRes, NotificationDetail, NotificationFeedbackReq } from '@ijime/api-types';
import { expect, test, type Page } from '@playwright/test';

const API = 'http://localhost:8080';
const me: MeRes = {
  guardian: { guardianId: 'g_feedback', role: 'primary', email: '' },
  family: { familyId: 'f_feedback', termsVersion: 'v1', consentComplete: true },
  children: [],
};
const suggestion = '答えを急がず、お子さんが話せる時間を一緒に決めてください。';
const initialNotice: NotificationDetail = {
  id: 'n_feedback',
  childId: 'c_feedback',
  kind: 'care_hint',
  title: 'お子さんからのお知らせ',
  createdAt: '2026-10-07T00:00:00.000Z',
  changes: [],
  meaning: '',
  suggestions: { try: [suggestion], avoid: [] },
  childSummary: '一緒に考えてほしいことがある。',
  resources: [
    {
      id: 'test-support',
      name: '合成テストの相談窓口',
      phone: '000-000-0000',
      hours: 'テスト用',
      audience: '保護者',
    },
  ],
  reason: { domains: [], days: 1 },
};

async function setup(page: Page) {
  const state = {
    notice: structuredClone(initialNotice),
    feedbackWrites: [] as NotificationFeedbackReq[],
    acknowledgements: 0,
    failFeedback: false,
    failAck: false,
  };
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === '/v1/me') return route.fulfill({ json: me });
    if (path === '/v1/notifications') return route.fulfill({ json: { items: [state.notice] } });
    if (path === '/v1/notifications/n_feedback') return route.fulfill({ json: state.notice });
    if (path === '/v1/notifications/n_feedback/feedback' && req.method() === 'PUT') {
      const body = req.postDataJSON() as NotificationFeedbackReq;
      state.feedbackWrites.push(body);
      if (state.failFeedback)
        return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
      state.notice.feedback = { action: body.action, updatedAt: '2026-10-07T01:00:00.000Z' };
      return route.fulfill({ json: { feedback: state.notice.feedback } });
    }
    if (path === '/v1/notifications/n_feedback/ack' && req.method() === 'POST') {
      state.acknowledgements++;
      if (state.failAck)
        return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } });
      state.notice.acknowledgedAt = '2026-10-07T01:01:00.000Z';
      return route.fulfill({ json: { acknowledgedAt: state.notice.acknowledgedAt } });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } });
  });
  return state;
}

const actions = [
  { action: 'talked', label: 'お子さんと話しました' },
  { action: 'planned', label: 'これから話す予定です' },
  { action: 'need_help', label: '対応について相談したいです' },
] as const;

for (const { action, label } of actions) {
  test(`records ${action} separately from acknowledgement and restores it after reload`, async ({
    page,
  }) => {
    const state = await setup(page);
    await page.goto('/notifications/n_feedback');
    const feedback = page.getByTestId('notification-feedback');
    await expect(feedback.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(feedback.getByRole('button', { name: '対応を保存' })).toBeDisabled();
    await feedback.getByRole('radio', { name: label }).check();
    await expect(page.getByTestId(`feedback-action-${action.replace('_', '-')}`)).toBeChecked();
    expect(state.feedbackWrites).toHaveLength(0);
    await feedback.getByRole('button', { name: '対応を保存' }).click();
    await expect(page.getByTestId('notification-feedback-saved')).toContainText(
      '問題の解決や、お子さんの安心を確認したものではありません',
    );
    expect(state.feedbackWrites).toEqual([{ action }]);
    expect(state.acknowledgements).toBe(0);
    await expect(page.getByTestId('notification-ack')).toBeVisible();
    await page.reload();
    await expect(feedback.getByRole('radio', { name: label })).toBeChecked();
    await expect(page.getByTestId('notification-feedback-current')).toContainText(label);
    await expect(page.getByTestId('notification-feedback-saved')).toHaveCount(0);
    await expect(page.getByTestId('notification-ack')).toBeVisible();
    if (action === 'need_help') {
      const help = page.getByTestId('notification-feedback-help');
      await expect(help).toContainText(suggestion);
      await expect(help).toContainText('相談先への連絡は行われません');
      await help.getByRole('link', { name: '相談先を見る' }).click();
      await expect(page).toHaveURL(/#notification-resources$/);
      await expect(page.locator('#notification-resources')).toContainText('合成テストの相談窓口');
    }
    await expect(page.getByTestId('child-approved-summary')).toHaveText(
      'お子さんが共有を選んだ言葉一緒に考えてほしいことがある。',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

test('acknowledgement alone does not invent guardian action feedback', async ({ page }) => {
  const state = await setup(page);
  await page.goto('/notifications/n_feedback');
  await page.getByTestId('notification-ack').click();
  await expect(page.getByTestId('notification-acknowledged')).toContainText(
    '問題の解決を意味しません',
  );
  expect(state.feedbackWrites).toEqual([]);
  await expect(page.getByTestId('notification-feedback-current')).toHaveCount(0);
  await expect(page.getByTestId('notification-feedback-saved')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('notification-acknowledged')).toBeVisible();
  await expect(
    page.getByTestId('notification-feedback').getByRole('radio', { checked: true }),
  ).toHaveCount(0);
});

test('failed feedback save retains the prior record, shows no success, and can be retried', async ({
  page,
}) => {
  const state = await setup(page);
  state.notice.feedback = { action: 'planned', updatedAt: '2026-10-07T00:30:00.000Z' };
  state.failFeedback = true;
  await page.goto('/notifications/n_feedback');
  const feedback = page.getByTestId('notification-feedback');
  await feedback.getByRole('radio', { name: 'お子さんと話しました' }).check();
  await feedback.getByRole('button', { name: '対応を保存' }).click();
  await expect(feedback.getByRole('alert')).toContainText('保存の完了を確認できませんでした');
  await expect(page.getByTestId('notification-feedback-saved')).toHaveCount(0);
  await expect(page.getByTestId('notification-feedback-current')).toContainText(
    'これから話す予定です',
  );
  await expect(feedback.getByRole('radio', { name: 'お子さんと話しました' })).toBeChecked();
  expect(state.acknowledgements).toBe(0);
  state.failFeedback = false;
  await feedback.getByRole('button', { name: '対応を保存' }).click();
  await expect(page.getByTestId('notification-feedback-saved')).toBeVisible();
  await expect(feedback.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('notification-feedback-current')).toContainText(
    'お子さんと話しました',
  );
  await feedback.getByRole('radio', { name: '対応について相談したいです' }).check();
  await expect(page.getByTestId('notification-feedback-saved')).toHaveCount(0);
  await page.reload();
  await expect(feedback.getByRole('radio', { name: 'お子さんと話しました' })).toBeChecked();
});

test('feedback success does not hide an acknowledgement failure', async ({ page }) => {
  const state = await setup(page);
  state.failAck = true;
  await page.goto('/notifications/n_feedback');
  const feedback = page.getByTestId('notification-feedback');
  await feedback.getByRole('radio', { name: 'これから話す予定です' }).check();
  await feedback.getByRole('button', { name: '対応を保存' }).click();
  await expect(page.getByTestId('notification-feedback-saved')).toBeVisible();
  await page.getByTestId('notification-ack').click();
  await expect(page.getByTestId('notification-detail').getByRole('alert')).toContainText(
    'まだ操作は完了していません',
  );
  await expect(page.getByTestId('notification-acknowledged')).toHaveCount(0);
  await expect(page.getByTestId('notification-feedback-current')).toContainText(
    'これから話す予定です',
  );
});
