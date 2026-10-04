import { expect, test } from '@playwright/test';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080';
const GUARDIAN = process.env['PW_GUARDIAN_URL'] ?? 'http://localhost:3101';
const sources = {
  voice: false,
  typing: true,
  artwork_save: true,
  home_checkin: false,
  calendar: false,
};

test('explicit artwork confirmation, minimized guardian gallery and undo use the local real API', async ({
  page,
  context,
}, testInfo) => {
  const guardianId = `g_art_${Date.now()}_${testInfo.workerIndex}`;
  const guardianHeaders = { 'X-Dev-Guardian-Id': guardianId };
  expect(
    (
      await page.request.post(`${API}/v1/families`, {
        headers: guardianHeaders,
        data: { displayName: 'ローカル保護者' },
      })
    ).status(),
  ).toBe(201);
  for (const type of ['guardian_terms', 'guardian_sensitive']) {
    expect(
      (
        await page.request.post(`${API}/v1/consents`, {
          headers: guardianHeaders,
          data: { type, documentVersion: 'v0.1' },
        })
      ).status(),
    ).toBe(201);
  }
  const created = await page.request.post(`${API}/v1/children`, {
    headers: guardianHeaders,
    data: { nickname: 'えのテスト', gradeBand: 'high' },
  });
  expect(created.status()).toBe(201);
  const { childId } = await created.json();
  const childHeaders = { 'X-Dev-Child-Id': childId };
  expect(
    (
      await page.request.post(`${API}/v1/child/assent`, {
        headers: childHeaders,
        data: { documentVersion: 'v0.1', dataSources: sources },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`${API}/v1/child/pets`, {
        headers: childHeaders,
        data: { characterId: 'moko', petName: '' },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/pair');
  await page.evaluate(
    ({ childId, sources }) =>
      localStorage.setItem(
        'mamori-child',
        JSON.stringify({
          state: {
            paired: true,
            childId,
            assented: true,
            gradeBand: 'high',
            characterId: 'moko',
            petName: '',
            dataSources: sources,
            readAloud: false,
          },
          version: 0,
        }),
      ),
    { childId, sources },
  );
  await page.goto('/draw/story');
  await expect(page.getByTestId('story-prompt')).toBeVisible();
  await page.getByTestId('artwork-save').check();
  const canvas = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(canvas.x + 30, canvas.y + 30);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 100, canvas.y + 80, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId('draw-done').click();
  const privateNarrative = 'えには あおい そらを かいたよ';
  await page.getByTestId('narrative-input').fill(privateNarrative);
  const submitted = page.waitForResponse(
    (res) => res.url().endsWith('/v1/child/artworks') && res.request().method() === 'POST',
  );
  await page.getByTestId('narrative-done').click();
  expect((await submitted).status()).toBe(201);
  const { artworkId } = await (await submitted).json();
  const galleryUrl = `${API}/v1/children/${childId}/shared-artworks`;
  expect(await (await page.request.get(galleryUrl, { headers: guardianHeaders })).json()).toEqual({
    items: [],
  });
  await page.getByTestId('artwork-share').click();
  await expect(page.getByTestId('artwork-share-confirmation')).toBeVisible();
  await page.getByTestId('artwork-share-cancel').click();
  expect(await (await page.request.get(galleryUrl, { headers: guardianHeaders })).json()).toEqual({
    items: [],
  });
  await page.getByTestId('artwork-share').click();
  await page.getByTestId('artwork-share-confirm').click();
  await expect(page.getByTestId('artwork-shared')).toBeVisible();
  const projection = await (
    await page.request.get(galleryUrl, { headers: guardianHeaders })
  ).json();
  expect(projection.items).toHaveLength(1);
  expect(Object.keys(projection.items[0]).sort()).toEqual([
    'artworkId',
    'imageUrl',
    'sharedAt',
    'type',
  ]);
  expect(JSON.stringify(projection)).not.toContain(privateNarrative);
  const guardian = await context.newPage();
  await guardian.goto(GUARDIAN);
  await guardian.evaluate((id) => localStorage.setItem('mamori-guardian-id', id), guardianId);
  await guardian.goto(`${GUARDIAN}/children/${childId}/shared`);
  const artwork = guardian.locator(`[data-artwork-id="${artworkId}"]`);
  await expect(artwork).toBeVisible();
  await expect
    .poll(() =>
      artwork
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await expect(guardian.locator('body')).not.toContainText(privateNarrative);
  for (const width of [390, 1440]) {
    await guardian.setViewportSize({ width, height: 900 });
    expect(
      await guardian.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    await guardian.screenshot({
      path: testInfo.outputPath(`shared-artworks-${width}.png`),
      fullPage: true,
    });
  }
  await page.getByTestId('artwork-unshare').click();
  await expect(page.getByTestId('artwork-shared')).toHaveCount(0);
  await guardian.getByTestId('shared-artwork-refresh').click();
  await expect(guardian.getByTestId('shared-artwork-empty')).toBeVisible();
  await expect(guardian.getByTestId('shared-artwork')).toHaveCount(0);
  expect(await (await page.request.get(galleryUrl, { headers: guardianHeaders })).json()).toEqual({
    items: [],
  });
});
