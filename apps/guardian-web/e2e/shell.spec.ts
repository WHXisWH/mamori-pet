import { expect, test } from '@playwright/test';

test('home renders and installs the service worker', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'まもりペット 保護者用' })).toBeVisible();
  const res = await page.request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(async () => {
    const cache = await caches.open('shell-v1');
    return (await cache.match('/offline')) !== undefined;
  });
});
