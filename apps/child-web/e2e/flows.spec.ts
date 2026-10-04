import { expect, test, type Page } from '@playwright/test';

async function onboard(
  page: Page,
  opts: { grade?: 'low' | 'high' | 'jhs'; character?: string } = {},
) {
  await page.goto('/pair');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/pair');
  await page.getByTestId('pair-code').fill('123456');
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('assent')).toBeVisible();
  await page.evaluate(
    (id) => {
      const stored = JSON.parse(localStorage.getItem('mamori-child')!);
      stored.state.childId = id;
      localStorage.setItem('mamori-child', JSON.stringify(stored));
    },
    `c_flow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  );
  await page.reload();
  await expect(page.getByTestId('assent')).toBeVisible();
  await page.getByTestId('assent-next').click();
  await expect(page.getByTestId('rule-card')).toBeVisible();
  await page.getByTestId('assent-next').click();
  await page.getByTestId('assent-next').click();
  await page.getByTestId('assent-next').click();
  await expect(page.getByTestId('character-picker')).toBeVisible();
  await page.getByTestId(`pick-${opts.character ?? 'pokke'}`).click();
  await page.getByTestId('pet-name').fill('ぽこ');
  await page.getByTestId('choose-go').click();
  await expect(page.getByTestId('pet-room')).toBeVisible();
  if (opts.grade) {
    await page.goto('/settings');
    await page.getByTestId(`grade-${opts.grade}`).click();
    await expect(page.getByTestId(`grade-${opts.grade}`)).toHaveAttribute('aria-pressed', 'true');
    await page.goto('/');
  }
}

test.describe('onboarding', () => {
  test('pair → assent storybook → choose → room', async ({ page }) => {
    await onboard(page);
    await expect(page.getByTestId('pet-name')).toHaveText('ぽこ');
    await expect(
      page.locator('[data-testid="pet-room"] svg[data-character="pokke"]'),
    ).toBeVisible();
    await expect(page.getByTestId('greeting-bubble')).toBeVisible();
    await expect(page.getByTestId('help-button')).toBeVisible();
  });

  test('rejects an invalid code and redirects unpaired visitors', async ({ page }) => {
    await page.goto('/pair');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/chat');
    await expect(page).toHaveURL(/\/pair$/);
    await page.getByTestId('pair-code').fill('000000');
    await page.getByTestId('pair-submit').click();
    await expect(page.getByTestId('pair-error')).toBeVisible();
  });

  test('home check-in prompt submits manually and pet says okaeri', async ({ page }) => {
    await onboard(page);
    await page.goto('/?checkin=1');
    await expect(page.getByTestId('home-checkin')).toBeVisible();
    await page.getByTestId('home-checkin').getByRole('button').click();
    await expect(page.getByTestId('home-checkin')).toHaveCount(0);
    await expect(page.getByTestId('greeting-bubble')).toContainText('おかえり');
  });
});

test.describe('activities', () => {
  test('mood weather: pick, change freely, then confirm once', async ({ page }) => {
    await onboard(page);
    await page.getByTestId('tile-mood').click();
    await expect(page.getByTestId('mood-confirm')).toBeDisabled();
    let posts = 0;
    page.on('request', (req) => {
      if (req.url().endsWith('/v1/child/mood') && req.method() === 'POST') posts += 1;
    });
    await page.getByTestId('mood-sunny').click();
    await page.getByTestId('mood-rainy').click();
    await expect(page.getByTestId('mood-rainy')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('mood-sunny')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('mood-sunny')).toBeEnabled();
    expect(posts).toBe(0);
    const saved = page.waitForResponse(
      (res) => res.url().endsWith('/v1/child/mood') && res.request().method() === 'POST',
    );
    await page.getByTestId('mood-confirm').click();
    expect((await saved).ok()).toBe(true);
    expect(posts).toBe(1);
    await expect(page.getByTestId('mood-done')).toBeVisible();
    await page.goto('/mood');
    await expect(page.getByTestId('mood-done')).toBeVisible();
    await page.goto('/');
    await expect(page.getByTestId('tile-mood').locator('svg')).toBeVisible();
  });

  test('chat streams a reply from the real api + pet-agent, offers tell-adult, and crisis jumps to /safe', async ({
    page,
  }) => {
    await onboard(page);
    await page.getByTestId('tile-chat').click();
    await expect(page.getByTestId('msg-pet').first()).toBeVisible();
    await page.getByTestId('chat-input').fill('今日、学校でみんなに無視されてつらい');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-panel')).toHaveAttribute(
      'data-status',
      /sending|streaming/,
    );
    await expect(page.getByTestId('offer-tell-adult')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
    await expect(page.getByTestId('msg-pet').last()).toContainText('つらかったね');

    await page.getByTestId('chat-input').fill('もう 消えたい');
    await page.getByTestId('chat-send').click();
    await expect(page).toHaveURL(/\/safe$/);
    await expect(page.getByTestId('safe-mode')).toBeVisible();
    await expect(page.getByTestId('safe-mode')).toContainText('あなたの安全がいちばん大事');
    await expect(page.getByTestId('safe-mode')).not.toContainText('おうちの人に知らせるね');
    await expect(page.getByTestId('safe-call')).toHaveCount(2);
    await expect(page.getByTestId('safe-call').first()).toHaveAttribute('href', 'tel:0120078310');
    await page.getByTestId('adult-yes').click();
    await page.getByTestId('safe-back').click();
    await page.getByTestId('safe-confirm-yes').click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('tell-adult flow: self coaching and proxy summary', async ({ page }) => {
    await onboard(page);
    await page.getByTestId('tile-tell').click();
    await page.getByTestId('choice-self').click();
    await page.getByTestId('coach-next').click();
    await page.getByTestId('coach-next').click();
    await page.getByTestId('coach-next').click();
    await page.getByTestId('coach-finish').click();
    await expect(page.getByTestId('tell-result')).toHaveAttribute('data-choice', 'self');

    await page.goto('/tell');
    await page.getByTestId('choice-proxy').click();
    await page.getByTestId('summary-input').fill('学校で無視されてつらい');
    await page.getByTestId('summary-ok').click();
    await expect(page.getByTestId('tell-result')).toHaveAttribute('data-choice', 'proxy');
  });

  test('drawing canvas records strokes and exports a png', async ({ page }) => {
    await onboard(page);
    await page.goto('/draw/story');
    await expect(page.getByTestId('story-prompt')).toBeVisible();
    const canvas = page.locator('canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 90, { steps: 8 });
    await page.mouse.up();
    await expect(page.getByTestId('drawing-canvas')).toHaveAttribute('data-strokes', '1');
    await page.getByTestId('draw-done').click();
    await expect(page.getByTestId('narrative-recorder')).toBeVisible();
    await page.getByTestId('narrative-input').fill('これは わたし');
    await page.getByTestId('narrative-done').click();
    await expect(page.getByTestId('draw-page')).toHaveAttribute('data-step', 'done');
    const bytes = await page.locator('[data-png-bytes]').getAttribute('data-png-bytes');
    expect(Number(bytes)).toBeGreaterThan(100);
  });

  test('island: open from the home scene, add items, optionally pick self, save', async ({
    page,
  }) => {
    await onboard(page);
    await page.getByTestId('island-arrange').click();
    await expect(page).toHaveURL(/\/island$/);
    await expect(page.getByTestId('island-sandbox')).toBeVisible();
    const before = Number(await page.getByTestId('island-sandbox').getAttribute('data-items'));
    await page.getByTestId('catalog-rabbit_small').click();
    await page.getByTestId('catalog-bear').click();
    await expect(page.getByTestId('island-sandbox')).toHaveAttribute(
      'data-items',
      String(before + 2),
    );
    await expect(page.getByTestId('island-done')).toBeEnabled();
    await page.getByTestId('island-item-rabbit_small').first().click();
    await page.getByTestId('island-set-self').click();
    await expect(page.getByTestId('island-sandbox')).toHaveAttribute('data-self', /fig_/);
    const saved = page.waitForResponse(
      (res) => res.url().endsWith('/v1/child/island') && res.request().method() === 'PUT',
    );
    await page.getByTestId('island-done').click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByTestId('narrative-recorder')).toBeVisible();
  });
});

test.describe('settings and lock', () => {
  test('grade band changes font size and copy; pet lock gates the room', async ({ page }) => {
    await onboard(page, { grade: 'low' });
    await expect(page.locator('html')).toHaveAttribute('data-grade', 'low');
    await expect(page.getByTestId('help-button')).toHaveText('こまったら');
    await page.goto('/settings');
    await page.getByTestId('lock-set').click();
    for (const d of ['1', '2', '3', '4'])
      await page.getByRole('button', { name: d, exact: true }).click();
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('mamori-child')!);
      localStorage.setItem('mamori-child', JSON.stringify(raw));
    });
    await page.reload();
    await page.goto('/');
    await expect(page.getByTestId('pin-pad')).toBeVisible();
    for (const d of ['9', '9', '9', '9'])
      await page.getByRole('button', { name: d, exact: true }).click();
    await expect(page.getByTestId('pin-error')).toBeVisible();
    for (const d of ['1', '2', '3', '4'])
      await page.getByRole('button', { name: d, exact: true }).click();
    await expect(page.getByTestId('pet-room')).toBeVisible();
  });
});
