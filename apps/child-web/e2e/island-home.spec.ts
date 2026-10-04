import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PET_REQUEST, routeIslandApi, seedChild } from './fixtures/island';

test.use({ serviceWorkers: 'block' });

const here = dirname(fileURLToPath(import.meta.url));
const shotsDir = resolve(here, '../test-results/island-home');
const DAYTIME = new Date('2026-10-03T14:30:00+09:00');
const BEDTIME = new Date('2026-10-03T20:30:00+09:00');

async function noHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
}

test('home shows the island, the agent greeting and the island hotspots', async ({ page }) => {
  await page.clock.setFixedTime(DAYTIME);
  await seedChild(page);
  await routeIslandApi(page);
  await page.goto('/');
  const scene = page.getByTestId('pet-room');
  await expect(scene).toBeVisible();
  await expect(scene).toHaveAttribute('data-stage', '3');
  await expect(scene).toHaveAttribute('data-season', 'autumn');
  await expect(scene.locator('svg[data-sky="day"]')).toHaveCount(1);
  await expect(scene.locator('svg[data-stage="3"][data-season="autumn"]')).toHaveCount(1);
  await expect(page.getByTestId('greeting-bubble')).toHaveAttribute('data-source', 'agent');
  await expect(page.getByTestId('greeting-bubble')).toContainText('今日も来てくれてうれしいな。');
  await expect(page.getByTestId('island-visit-days')).toContainText('12');
  await expect(page.getByTestId('pet-name')).toHaveText('もこ');
  await expect(page.getByTestId('tile-chat')).toHaveAttribute('href', '/chat');
  await expect(page.getByTestId('tile-chat').locator('svg[data-character="moko"]')).toBeVisible();
  await expect(page.getByTestId('tile-mood')).toHaveAttribute('href', '/mood');
  await expect(page.getByTestId('island-arrange')).toHaveAttribute('href', '/island');
  await expect(page.getByTestId('tile-tell')).toHaveAttribute('href', '/tell');
  await expect(page.getByTestId('island-jar')).toHaveCount(0);
  await expect(page.getByTestId('tile-draw-self')).toHaveCount(0);
  await expect(page.getByTestId('tile-draw-story')).toHaveCount(0);
  await expect(page.getByTestId('decoration-thumb')).toHaveCount(1);
  await page.getByTestId('island-house').click();
  await expect(page.getByTestId('decorations-dialog')).toBeVisible();
  await expect(page.getByTestId('decoration-large')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('decorations-dialog')).toHaveCount(0);
});

test('today mood colours the sky and the sky link shows the weather', async ({ page }) => {
  await page.clock.setFixedTime(DAYTIME);
  await seedChild(page);
  await routeIslandApi(page, { home: { todayMood: 'rainy' } });
  await page.goto('/');
  await expect(page.getByTestId('pet-room').locator('svg[data-sky="rainy"]')).toHaveCount(1);
  await expect(page.getByTestId('tile-mood').locator('svg')).toBeVisible();
  await expect(page.getByTestId('tile-mood')).toHaveAttribute('aria-label', /雨/);
});

test('tapping the plant records one watering and shows the watered state', async ({ page }) => {
  await page.clock.setFixedTime(DAYTIME);
  await seedChild(page);
  const calls = await routeIslandApi(page);
  await page.goto('/');
  const plant = page.getByTestId('island-plant');
  await expect(plant).toHaveAttribute('data-watered', 'false');
  await plant.click();
  await expect(plant).toHaveAttribute('data-watered', 'true');
  await expect(plant).toHaveAttribute('aria-pressed', 'true');
  expect(calls.rituals).toEqual([{ kind: 'watered', localDate: '2026-10-03' }]);
  await expect(page.getByTestId('home-status')).toContainText('水をあげたよ');
});

test('at bedtime the good-thing jar appears, counts a star and never sends the note', async ({
  page,
}) => {
  await page.clock.setFixedTime(BEDTIME);
  await seedChild(page);
  const calls = await routeIslandApi(page);
  await page.goto('/');
  await expect(page.getByTestId('pet-room').locator('svg[data-sky="night"]')).toHaveCount(1);
  const jar = page.getByTestId('island-jar');
  await expect(jar).toBeVisible();
  await expect(jar).toHaveAttribute('data-count', '4');
  await jar.click();
  await expect(jar).toHaveAttribute('data-count', '5');
  await expect(jar).toHaveAttribute('data-done', 'true');
  await expect(jar).toBeDisabled();
  expect(calls.rituals).toEqual([{ kind: 'good_thing', localDate: '2026-10-03' }]);
  await expect(page.getByTestId('good-thing-note')).toBeVisible();
  await page.getByTestId('good-thing-text').fill('きょうは ともだちと あそんだ');
  await page.getByTestId('good-thing-close').click();
  await expect(page.getByTestId('good-thing-note')).toHaveCount(0);
  for (const req of calls.requests) expect(req.postData() ?? '').not.toContain('あそんだ');
  expect(calls.rituals).toHaveLength(1);
});

test('a pet request shows one card with the reward and can be declined without pressure', async ({
  page,
}) => {
  await page.clock.setFixedTime(DAYTIME);
  await seedChild(page);
  const second = { ...PET_REQUEST, requestId: 'req_fixture_2', promptText: 'ふたつめ' };
  const calls = await routeIslandApi(page, { home: { petRequests: [PET_REQUEST, second] } });
  await page.goto('/');
  const card = page.getByTestId('pet-request-card');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveAttribute('data-request-id', 'req_fixture_1');
  await expect(card).toContainText('すきな たべものを かいて ほしいな');
  await expect(card.getByTestId('pet-request-reward')).toHaveAttribute('data-item', 'lantern');
  await expect(card.getByTestId('pet-request-reward').locator('svg[data-sprite]')).toBeVisible();
  await expect(card.getByTestId('pet-request-open')).toHaveAttribute(
    'href',
    '/requests/req_fixture_1',
  );
  await expect(card).not.toContainText(/あと|時間|分/);
  await card.getByTestId('pet-request-decline').click();
  expect(calls.declined).toEqual(['req_fixture_1']);
  await expect(page.getByTestId('pet-request-card')).toHaveAttribute(
    'data-request-id',
    'req_fixture_2',
  );
  await expect(page.getByTestId('pet-request-card')).toHaveCount(1);
});

test('/island starts from the saved layout, greys locked items, moves by keyboard and PUTs the scene', async ({
  page,
}) => {
  await seedChild(page);
  const calls = await routeIslandApi(page);
  await page.goto('/island');
  const sandbox = page.getByTestId('island-sandbox');
  await expect(sandbox).toHaveAttribute('data-items', '2');
  await expect(sandbox).toHaveAttribute('data-self', 'fig_1');
  await expect(page.getByTestId('island-item-rabbit_small')).toBeVisible();
  await expect(page.getByTestId('island-item-tree')).toBeVisible();
  await expect(page.getByTestId('island-keyboard-help')).toBeVisible();
  const locked = page.getByTestId('catalog-lantern');
  await expect(locked).toBeDisabled();
  await expect(locked).toHaveAttribute('data-locked', 'true');
  await expect(page.getByTestId('island-locked-hint')).toBeVisible();

  await page.getByTestId('catalog-bear').click();
  await expect(sandbox).toHaveAttribute('data-items', '3');
  const bear = page.getByTestId('island-item-bear');
  await expect(bear).toHaveAttribute('aria-pressed', 'true');
  const before = await bear.boundingBox();
  await bear.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  const after = await bear.boundingBox();
  expect(after!.x).toBeGreaterThan(before!.x);
  expect(after!.y).toBeGreaterThan(before!.y);

  await page.getByTestId('island-item-rabbit_small').click();
  await expect(page.getByTestId('island-set-self')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('island-set-self').click();
  await expect(sandbox).toHaveAttribute('data-self', '');
  await expect(page.getByTestId('island-done')).toBeEnabled();
  await page.getByTestId('island-done').click();
  await expect(page.getByTestId('island-page')).toHaveAttribute('data-step', 'tell');
  expect(calls.puts).toHaveLength(1);
  expect(calls.puts[0]!.items).toHaveLength(3);
  expect(calls.puts[0]!.selfFigureId).toBeUndefined();
  expect(calls.puts[0]!.narrative).toBeUndefined();
  expect(calls.puts[0]!.items.map((i) => i.catalogId)).toEqual(['rabbit_small', 'tree', 'bear']);
  expect(calls.requests.some((r) => r.url().endsWith('/island-scenes'))).toBe(false);

  await page.getByTestId('narrative-input').fill('みんなで うみを みている');
  await page.getByTestId('narrative-done').click();
  await expect(page.getByTestId('island-saved')).toBeVisible();
  expect(calls.puts).toHaveLength(2);
  expect(calls.puts[1]!.narrative).toEqual({ mode: 'typed', text: 'みんなで うみを みている' });
});

for (const viewport of [
  { name: 'mobile', width: 412, height: 915 },
  { name: 'desktop', width: 1440, height: 900 },
]) {
  test(`${viewport.name} home fits without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.clock.setFixedTime(BEDTIME);
    await seedChild(page);
    await routeIslandApi(page, { home: { petRequests: [PET_REQUEST], todayMood: 'sunny' } });
    await page.goto('/');
    await expect(page.getByTestId('pet-room')).toBeVisible();
    await expect(page.getByTestId('pet-request-card')).toBeVisible();
    await expect(page.getByTestId('island-jar')).toBeVisible();
    await noHorizontalOverflow(page);
    await page.evaluate(() => document.fonts.ready);
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({
      path: resolve(shotsDir, `home-${viewport.name}-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await page.goto('/island');
    await expect(page.getByTestId('island-sandbox')).toBeVisible();
    await noHorizontalOverflow(page);
    await page.screenshot({
      path: resolve(shotsDir, `island-${viewport.name}-${viewport.width}x${viewport.height}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  });
}
