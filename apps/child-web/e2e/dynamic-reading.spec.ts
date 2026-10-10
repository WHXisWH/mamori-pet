import { expect, test } from '@playwright/test';

import { PET_REQUEST, routeIslandApi, seedChild } from './fixtures/island';

const TEXT = '図書館で新聞を読んだ。運動会の練習も楽しかった。';

test('real local dictionary annotates dynamic greeting and request text without an API call', async ({
  page,
}, testInfo) => {
  await seedChild(page, 'low');
  await routeIslandApi(page, {
    home: {
      gradeBand: 'low',
      greeting: { text: TEXT, expression: 'happy', source: 'agent' },
      petRequests: [{ ...PET_REQUEST, promptText: TEXT }],
    },
  });
  const errors: string[] = [];
  const posted: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'GET') posted.push(request.postData() ?? '');
  });
  await page.goto('/');
  for (const id of ['greeting-bubble', 'pet-request-card']) {
    const area = page.getByTestId(id);
    await expect(area.locator('rt')).toContainText(
      ['としょかん', 'しんぶん', 'よん', 'うんどうかい', 'れんしゅう', 'たのしかっ'],
      { timeout: 30_000 },
    );
  }
  expect(posted.some((body) => body.includes(TEXT))).toBe(false);
  expect(errors).toEqual([]);
  for (const [width, height] of [
    [393, 852],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`dynamic-reading-${width}.png`),
      fullPage: true,
    });
  }
});

test('higher grades do not download the reading dictionary', async ({ page }) => {
  await seedChild(page, 'high');
  await routeIslandApi(page, {
    home: { greeting: { text: TEXT, expression: 'happy', source: 'agent' } },
  });
  const dictionaryRequests: string[] = [];
  page.on('request', (request) => {
    if (/reading-worker|\/readings\//.test(request.url())) dictionaryRequests.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByTestId('greeting-bubble')).toContainText(TEXT);
  await expect(page.getByTestId('greeting-bubble').locator('ruby')).toHaveCount(0);
  expect(dictionaryRequests).toEqual([]);
});

test('cached dictionary can annotate new text offline in a fresh worker', async ({
  page,
  context,
}) => {
  await seedChild(page, 'low');
  await routeIslandApi(page, {
    home: { gradeBand: 'low', greeting: { text: TEXT, expression: 'happy', source: 'agent' } },
  });
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  // Reload under the active service worker so every dictionary response is cached.
  await page.reload();
  await expect(page.getByTestId('greeting-bubble').locator('rt').first()).toHaveText('としょかん', {
    timeout: 30_000,
  });
  await page.waitForFunction(async () => {
    const cache = await caches.open('shell-v3');
    const paths = (await cache.keys()).map((request) => new URL(request.url).pathname);
    return (
      paths.filter((path) => path.startsWith('/readings/') && path.endsWith('.dat.gz')).length ===
        12 &&
      paths.includes('/reading-worker.js') &&
      paths.includes('/readings/kuromoji-0.1.2/build/kuromoji.js')
    );
  });
  await context.setOffline(true);
  const readings = await page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const worker = new Worker('/reading-worker.js');
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error('offline dictionary timeout'));
        }, 10_000);
        worker.onmessage = ({ data }) => {
          clearTimeout(timeout);
          worker.terminate();
          resolve((data.tokens ?? []).map((token: { reading?: string }) => token.reading ?? ''));
        };
        worker.onerror = () => {
          clearTimeout(timeout);
          worker.terminate();
          reject(new Error('offline dictionary failed'));
        };
        worker.postMessage({ id: 1, text: '宇宙飛行士' });
      }),
  );
  expect(readings.join('')).toBe('ウチュウヒコウシ');
});

test('a missing dictionary leaves the original text and safety navigation usable', async ({
  page,
}) => {
  await seedChild(page, 'low');
  await routeIslandApi(page, {
    home: { gradeBand: 'low', greeting: { text: TEXT, expression: 'happy', source: 'agent' } },
  });
  await page.route('**/reading-worker.js', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByTestId('greeting-bubble')).toContainText(TEXT);
  await page.getByTestId('help-button').click();
  await expect(page.locator('a[href="tel:189"]')).toBeVisible();
});
