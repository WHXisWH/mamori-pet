import { expect, test, type Page } from '@playwright/test';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080';
const sources = {
  voice: true,
  typing: true,
  artwork_save: false,
  home_checkin: true,
  calendar: true,
};

async function child(page: Page) {
  const id = `c_device_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const headers = { 'X-Dev-Child-Id': id };
  expect(
    (
      await page.request.post(`${API}/v1/child/assent`, {
        headers,
        data: { documentVersion: 'v0.1', dataSources: sources },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`${API}/v1/child/pets`, { headers, data: { characterId: 'moko' } })
    ).ok(),
  ).toBe(true);
  await page.goto('/pair');
  await page.evaluate(
    ({ id, sources }) =>
      localStorage.setItem(
        'mamori-child',
        JSON.stringify({
          state: {
            paired: true,
            assented: true,
            childId: id,
            gradeBand: 'high',
            characterId: 'moko',
            petName: '',
            dataSources: sources,
            petLock: null,
            readAloud: false,
          },
          version: 0,
        }),
      ),
    { id, sources },
  );
  return { id, headers };
}

test('home position stays on this device; only the boolean check-in reaches the API', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 35.123456, longitude: 139.123456 });
  const { id } = await child(page);
  await page.goto('/settings');
  await expect(page.getByTestId('home-location-save')).toBeEnabled();
  await page.getByTestId('home-location-save').click();
  await expect(page.getByTestId('home-location-status')).toHaveText('設定ずみ');
  expect(
    await page.evaluate(
      (id) => JSON.parse(localStorage.getItem(`mamori-home-geofence:${id}`)!),
      id,
    ),
  ).toMatchObject({ lat: 35.123456, lng: 139.123456 });
  const checkin = page.waitForResponse(
    (res) => res.url().endsWith('/home-checkins') && res.request().method() === 'POST',
  );
  await page.goto('/?checkin=1');
  const response = await checkin;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toEqual({ atHome: true, method: 'geo' });
  await page.goto('/settings');
  await page.getByTestId('home-location-clear').click();
  await expect(page.getByTestId('home-location-status')).toHaveText('まだ設定していません');
  expect(
    await page.evaluate((id) => localStorage.getItem(`mamori-home-geofence:${id}`), id),
  ).toBeNull();
});

test('read-aloud uses the local voice and respects the saved switch', async ({ page }) => {
  await page.addInitScript(() => {
    const spoken: string[] = [];
    Object.assign(window, { __spoken: spoken });
    // Use a complete stub pair: the native voice setter rejects plain test objects.
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: class {
        constructor(public text: string) {}
      },
    });
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        cancel: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        getVoices: () => [
          { lang: 'ja-JP', localService: false },
          { lang: 'ja-JP', localService: true },
        ],
        speak: (utterance: SpeechSynthesisUtterance) => {
          if (!utterance.voice?.localService) throw new Error('remote voice forbidden');
          spoken.push(utterance.text);
        },
      },
    });
  });
  const { headers } = await child(page);
  expect(
    (
      await page.request.put(`${API}/v1/child/preferences`, {
        headers,
        data: { gradeBand: 'low', ttsEnabled: true },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('mamori-child')!).state.readAloud),
    )
    .toBe(true);
  await page.goto('/chat');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.length))
    .toBe(1);
  await page.getByTestId('chat-input').fill('こんにちは');
  await page.getByTestId('chat-send').click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.length))
    .toBe(2);
  expect(
    (
      await page.request.put(`${API}/v1/child/preferences`, {
        headers,
        data: { gradeBand: 'low', ttsEnabled: false },
      })
    ).ok(),
  ).toBe(true);
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(() => JSON.parse(localStorage.getItem('mamori-child')!).state.readAloud),
    )
    .toBe(false);
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)).toEqual(
    [],
  );
});
