import type { ChildPreferencesBody, GradeBand } from '@ijime/api-types';
import { expect, test, type Page } from '@playwright/test';

import { PET_REQUEST, routeIslandApi, seedChild } from './fixtures/island';

async function prepare(page: Page, gradeBand: GradeBand, localVoice = true) {
  await seedChild(page, gradeBand, { readAloud: true });
  await routeIslandApi(page, {
    home: {
      gradeBand,
      petRequests: [{ ...PET_REQUEST, promptText: '学校で大人に話そう。' }],
    },
  });
  let preferences: ChildPreferencesBody = {
    gradeBand,
    ttsEnabled: true,
    proactiveEnabled: true,
    proactiveSlots: ['after_school'],
  };
  await page.route('**/v1/child/preferences', (route) => {
    if (route.request().method() === 'PUT')
      preferences = route.request().postDataJSON() as ChildPreferencesBody;
    return route.fulfill({ json: preferences });
  });
  for (const resource of ['memories', 'memory-proposals']) {
    await page.route(`**/v1/child/${resource}`, (route) => route.fulfill({ json: { items: [] } }));
  }
  await page.route('**/v1/child/help-resources', (route) => route.abort());
  await page.addInitScript((hasLocalVoice) => {
    const spoken: string[] = [];
    Object.defineProperty(window, '__rhythmSpoken', { value: spoken });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: class {
        constructor(public text: string) {}
      },
    });
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        cancel() {},
        getVoices: () => [{ lang: 'ja-JP', localService: hasLocalVoice }],
        speak: (utterance: { text: string }) => spoken.push(utterance.text),
      },
    });
  }, localVoice);
}

function spoken(page: Page) {
  return page.evaluate(() => (window as unknown as { __rhythmSpoken: string[] }).__rhythmSpoken);
}

for (const gradeBand of ['low', 'high', 'jhs'] as const) {
  test(`${gradeBand}: open page updates at 23:00 JST and resets at 05:00`, async ({
    page,
  }, testInfo) => {
    await prepare(page, gradeBand);
    await page.clock.install({ time: new Date('2026-10-06T13:59:00Z') });
    await page.clock.pauseAt(new Date('2026-10-06T13:59:30Z'));
    await page.goto('/');
    await expect(page.getByTestId('pet-request-card')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-night', 'false');
    await expect(page.getByTestId('rest-reminder')).toHaveCount(0);
    await page.clock.runFor(30_000);
    await expect(page.locator('html')).toHaveAttribute('data-night', 'true');
    await expect(page.getByTestId('rest-reminder')).toBeVisible();
    await expect(page.getByTestId('help-button')).toBeVisible();
    await expect(page.getByTestId('pet-request-decline')).toBeEnabled();
    await expect(page.getByTestId('pet-request-card').locator('p[lang="ja"]')).toHaveCSS(
      'color',
      'rgb(59, 58, 54)',
    );
    expect(await spoken(page)).toEqual([]);
    await page.getByTestId('rest-reminder').getByTestId('read-aloud').click();
    expect((await spoken(page))[0]).toMatch(/やす|休/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    const mobilePath = testInfo.outputPath(`${gradeBand}-night-reminder.png`);
    await page.screenshot({ path: mobilePath, fullPage: true });
    await testInfo.attach(`${gradeBand}-night-reminder`, {
      path: mobilePath,
      contentType: 'image/png',
    });
    if (gradeBand === 'high') {
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByTestId('rest-reminder')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      const desktopPath = testInfo.outputPath('desktop-night-reminder.png');
      await page.screenshot({ path: desktopPath, fullPage: true });
      await testInfo.attach('desktop-night-reminder', {
        path: desktopPath,
        contentType: 'image/png',
      });
    }
    await page.clock.fastForward(6 * 60 * 60 * 1000);
    await expect(page.locator('html')).toHaveAttribute('data-night', 'false');
    await expect(page.getByTestId('rest-reminder')).toHaveCount(0);
  });
}

test('late-night help and family safety stay reachable and silent until a manual reading', async ({
  page,
}) => {
  await prepare(page, 'low');
  await page.clock.install({ time: new Date('2026-10-06T14:00:00Z') });
  await page.goto('/');
  await expect(page.getByTestId('rest-reminder')).toBeVisible();
  await page.getByTestId('help-button').click();
  await expect(page.getByTestId('rest-reminder')).toHaveCount(0);
  await expect(page.locator('a[href="tel:189"]')).toBeVisible();
  expect(await spoken(page)).toEqual([]);
  await page.goto('/safe?family=1');
  await expect(page.getByTestId('safe-mode')).toBeVisible();
  await expect(page.getByTestId('safe-call').filter({ hasText: '189' })).toBeVisible();
  await expect(page.getByTestId('adult-yes')).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await expect(page.locator('html')).toHaveAttribute('data-night', 'false');
  await expect(page.getByTestId('rest-reminder')).toHaveCount(0);
  expect(await spoken(page)).toEqual([]);
  await page.getByTestId('read-aloud').click();
  expect((await spoken(page))[0]).toContain('189');
});

test('static request readings respect a saved reading switch', async ({ page }) => {
  await prepare(page, 'low');
  await page.clock.install({ time: new Date('2026-10-06T03:00:00Z') });
  await page.goto('/');
  const request = page.getByTestId('pet-request-card');
  await expect(request.locator('ruby rt')).toHaveText(['がっこう', 'おとな', 'はなそう']);
  expect(await spoken(page)).toEqual([]);
  await request.getByTestId('read-aloud').click();
  expect(await spoken(page)).toEqual(['学校で大人に話そう。']);
  await page.goto('/settings');
  const toggle = page.getByRole('checkbox', { name: 'よみあげ', exact: true });
  await expect(toggle).toBeEnabled();
  // This controlled input changes only after the server confirms the preference.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('read-aloud')).toHaveCount(0);
  await page.goto('/');
  await expect(request).toBeVisible();
  await expect(request.locator('ruby rt')).toHaveCount(3);
  await expect(request.getByTestId('read-aloud')).toHaveCount(0);
});

test('an unavailable local Japanese voice never falls back to remote speech', async ({ page }) => {
  await prepare(page, 'low', false);
  await page.goto('/');
  const request = page.getByTestId('pet-request-card');
  await expect(request).toBeVisible();
  await request.getByTestId('read-aloud').click();
  expect(await spoken(page)).toEqual([]);
  await expect(page.getByTestId('pet-request-decline')).toBeEnabled();
  await page.getByTestId('help-button').click();
  await expect(page.locator('a[href="tel:189"]')).toBeVisible();
});
