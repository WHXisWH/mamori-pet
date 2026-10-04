import { expect, test } from '@playwright/test';

test('family safety UI contract fixture keeps the 189 resource and hides parent-contact prompt', async ({
  page,
}) => {
  await page.goto('/help');
  await page.evaluate(() =>
    sessionStorage.setItem(
      'mamori-crisis',
      JSON.stringify({
        crisisId: 'ui-contract-fixture',
        message: 'あんぜんな おとなに そうだんしよう。',
        resources: [{ id: 'jidou_soudan', name: '児童相談所', phone: '189', audience: 'child' }],
      }),
    ),
  );
  await page.goto('/safe');
  await expect(page.getByTestId('safe-call').first()).toHaveAttribute('href', 'tel:189');
  await expect(page.getByTestId('adult-yes')).toHaveCount(0);
});

test.describe('/help', () => {
  test('lists hotlines with tap-to-call links and works offline', async ({ page, context }) => {
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: '相談できるところ' })).toBeVisible();

    const list = page.getByTestId('hotline-list');
    await expect(list.getByRole('listitem')).toHaveCount(4);
    await expect(list).toHaveAttribute('data-version', /^0\.1\.0\//);

    const calls = page.getByTestId('hotline-call');
    await expect(calls.first()).toHaveAttribute('href', 'tel:0120078310');
    await expect(calls.nth(2)).toHaveAttribute('href', 'tel:189');
    await expect(page.getByText('24時間子供SOSダイヤル')).toBeVisible();
    await expect(page.getByTestId('offline-notice')).toHaveCount(0);

    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      if (!reg.active) throw new Error('no active service worker');
      await new Promise<void>((resolve) => {
        if (reg.active?.state === 'activated') return resolve();
        reg.active?.addEventListener('statechange', () => {
          if (reg.active?.state === 'activated') resolve();
        });
      });
    });
    await page.waitForFunction(async () => {
      if (!navigator.serviceWorker.controller) return false;
      const shellCaches = (await caches.keys()).filter((name) => name.startsWith('shell-'));
      for (const name of shellCaches) {
        const cache = await caches.open(name);
        const help = await cache.match('/help');
        if (help?.headers.get('Content-Type')?.includes('text/html')) return true;
      }
      return false;
    });

    await context.setOffline(true);
    await page.goto('/help');
    await expect(page.getByRole('heading', { name: '相談できるところ' })).toBeVisible();
    await expect(page.getByTestId('hotline-list').getByRole('listitem')).toHaveCount(4);
    await expect(page.getByTestId('hotline-call').first()).toHaveAttribute(
      'href',
      'tel:0120078310',
    );
    await expect(page.getByTestId('offline-notice')).toBeVisible();
    await context.setOffline(false);
  });

  test('every page shows the help entry point', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: '困ったときの連絡先をひらく' })).toBeVisible();
  });
});
