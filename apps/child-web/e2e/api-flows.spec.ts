import { expect, test, type Page } from '@playwright/test';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080';
const GUARDIAN = process.env['PW_GUARDIAN_URL'] ?? 'http://localhost:3101';
const sources = {
  voice: true,
  typing: true,
  artwork_save: false,
  home_checkin: true,
  calendar: true,
};

// Only the local development identity is initialized here. All business actions use the API.
async function localChild(page: Page, id: string) {
  const headers = { 'X-Dev-Child-Id': id };
  const assent = await page.request.post(`${API}/v1/child/assent`, {
    headers,
    data: { documentVersion: 'v0.1', dataSources: sources },
  });
  expect(assent.ok()).toBe(true);
  const pet = await page.request.post(`${API}/v1/child/pets`, {
    headers,
    data: { characterId: 'moko', petName: '' },
  });
  expect(pet.ok()).toBe(true);
  await page.goto('/pair');
  await page.evaluate(
    ({ id, sources }) =>
      localStorage.setItem(
        'mamori-child',
        JSON.stringify({
          state: {
            paired: true,
            childId: id,
            assented: true,
            gradeBand: 'high',
            characterId: 'moko',
            petName: '',
            dataSources: sources,
            todayMood: null,
            lastHomeCheckin: null,
            petLock: null,
            readAloud: false,
          },
          version: 0,
        }),
      ),
    { id, sources },
  );
  await page.goto('/');
  await expect(page.getByTestId('local-test-mode')).toBeVisible();
  return headers;
}

async function stroke(page: Page) {
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + 80, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId('draw-done').click();
}

test('memory is absent until consent, persists on the server, then DELETE removes it', async ({
  page,
}) => {
  const headers = await localChild(page, `c_memory_${Date.now()}`);
  await page.goto('/chat');
  await expect(page.getByTestId('chat-send')).toBeDisabled();
  await page.getByTestId('chat-input').fill('ねこが すきなこと、おぼえてて');
  await page.getByTestId('chat-send').click();
  const card = page.getByTestId('memory-proposal');
  await expect(card).toHaveAttribute('data-status', 'pending');
  expect(
    (await (await page.request.get(`${API}/v1/child/memories`, { headers })).json()).items,
  ).toHaveLength(0);
  const save = page.waitForResponse(
    (res) => res.url().includes('/memory-proposals/') && res.request().method() === 'POST',
  );
  await card.getByTestId('memory-accept').click();
  expect((await save).ok()).toBe(true);
  await expect(card).toHaveAttribute('data-status', 'saved');
  const memories = await (await page.request.get(`${API}/v1/child/memories`, { headers })).json();
  expect(memories.items).toHaveLength(1);
  await page.goto('/settings');
  const remove = page.waitForResponse(
    (res) => res.url().includes('/memories/') && res.request().method() === 'DELETE',
  );
  await page.getByRole('button', { name: /を消す/ }).click();
  expect((await remove).status()).toBe(204);
  expect(
    (await (await page.request.get(`${API}/v1/child/memories`, { headers })).json()).items,
  ).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.getItem('mamori-child'))).not.toContain('ねこが');
});

test('mood and data sources survive reload; an offline update is not reported as success', async ({
  page,
  context,
}) => {
  const headers = await localChild(page, `c_settings_${Date.now()}`);
  await page.goto('/mood');
  const moodResponse = page.waitForResponse(
    (res) => res.url().endsWith('/v1/child/mood') && res.request().method() === 'POST',
  );
  await page.getByTestId('mood-sunny').click();
  await page.getByTestId('mood-confirm').click();
  expect((await moodResponse).ok()).toBe(true);
  const home = await (await page.request.get(`${API}/v1/child/home`, { headers })).json();
  expect(home.todayMood).toBe('sunny');
  await page.goto('/settings');
  await expect(page.getByTestId('source-voice')).toBeEnabled();
  const save = page.waitForResponse(
    (res) => res.url().endsWith('/data-sources') && res.request().method() === 'PUT',
  );
  await page.getByTestId('source-voice').click();
  expect((await save).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('source-voice')).not.toBeChecked();
  await expect(page.getByTestId('source-typing')).toBeEnabled();
  await context.setOffline(true);
  await page.getByTestId('source-typing').click();
  await expect(page.getByTestId('request-error')).toBeVisible();
  await expect(page.getByTestId('source-typing')).toBeChecked();
  await context.setOffline(false);
  await page.getByRole('button', { name: 'もういちど' }).click();
  await expect(page.getByTestId('request-error')).toHaveCount(0);
  await expect(page.getByTestId('source-typing')).toBeEnabled();
  await expect(page.getByTestId('source-typing')).toBeChecked();
});

test('story sends a real PNG and narrative; island narrative crisis enters safety mode', async ({
  page,
}) => {
  await localChild(page, `c_art_${Date.now()}`);
  await page.goto('/draw/story');
  await expect(page.getByTestId('story-prompt')).toBeVisible();
  await stroke(page);
  await page.getByTestId('narrative-input').fill('おともだちと いっしょに あそびました');
  const upload = page.waitForResponse(
    (res) => res.url().endsWith('/artworks') && res.request().method() === 'POST',
  );
  await page.getByTestId('narrative-done').click();
  const response = await upload;
  expect(response.ok()).toBe(true);
  expect(response.request().headers()['content-type']).toContain('multipart/form-data');
  expect((await response.json()).artworkId).toBeTruthy();
  await expect(page.getByTestId('draw-page')).toHaveAttribute('data-step', 'done');
  await page.goto('/island');
  await expect(page.getByTestId('island-sandbox')).toBeVisible();
  await page.getByTestId('catalog-rabbit_small').click();
  await page.getByTestId('island-set-self').click();
  const saved = page.waitForResponse(
    (res) => res.url().endsWith('/v1/child/island') && res.request().method() === 'PUT',
  );
  await page.getByTestId('island-done').click();
  expect((await saved).ok()).toBe(true);
  await page.getByTestId('narrative-input').fill('もう死にたい');
  const island = page.waitForResponse(
    (res) => res.url().endsWith('/v1/child/island') && res.request().method() === 'PUT',
  );
  await page.getByTestId('narrative-done').click();
  expect((await (await island).json()).crisis).toBeTruthy();
  await expect(page).toHaveURL(/\/safe$/);
});

test('child-approved proxy summary appears in guardian inbox and acknowledgement persists', async ({
  page,
  context,
}) => {
  await localChild(page, 'c_dev');
  await page.goto('/tell');
  await page.getByTestId('choice-proxy').click();
  const summary = `学校のことを相談したい ${Date.now()}`;
  await page.getByTestId('summary-input').fill(summary);
  const choice = page.waitForResponse((res) => res.url().endsWith('/choice'));
  await page.getByTestId('summary-ok').click();
  expect((await (await choice).json()).notificationQueued).toBe(true);
  await expect(page.getByTestId('tell-result')).toHaveAttribute('data-choice', 'proxy');
  const guardian = await context.newPage();
  await guardian.goto(GUARDIAN);
  await expect(guardian.getByTestId('local-test-mode')).toBeVisible();
  const headers = { 'X-Dev-Guardian-Id': 'g_dev' };
  const list = await (await guardian.request.get(`${API}/v1/notifications`, { headers })).json();
  let notificationId: string | undefined;
  for (const item of list.items) {
    const detail = await (
      await guardian.request.get(`${API}/v1/notifications/${item.id}`, { headers })
    ).json();
    expect(detail).not.toHaveProperty('level');
    if (detail.childSummary === summary) notificationId = item.id;
  }
  expect(notificationId).toBeTruthy();
  await guardian.goto(`${GUARDIAN}/notifications/${notificationId}`);
  await expect(guardian.getByTestId('child-approved-summary')).toContainText(summary);
  await guardian.getByTestId('notification-ack').click();
  await expect(guardian.getByTestId('notification-acknowledged')).toBeVisible();
  await guardian.reload();
  await expect(guardian.getByTestId('notification-acknowledged')).toBeVisible();
});

test('data deletion asks twice and reports accepted, not a completed erasure', async ({ page }) => {
  await localChild(page, `c_delete_${Date.now()}`);
  await page.goto('/settings');
  await page.getByTestId('delete-all').click();
  await expect(page.getByTestId('deletion-accepted')).toHaveCount(0);
  const request = page.waitForResponse((res) => res.url().endsWith('/data-deletion-requests'));
  await page.getByTestId('delete-confirm').click();
  expect((await (await request).json()).status).toBe('accepted');
  await expect(page.getByTestId('deletion-accepted')).toContainText(
    'まだ かんりょうでは ありません',
  );
});

test('voice without Google credentials fails explicitly instead of showing a fake conversation', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['microphone']);
  await localChild(page, `c_voice_${Date.now()}`);
  await page.goto('/chat');
  const sent: unknown[] = [];
  const received: unknown[] = [];
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/v1/voice') return;
    socket.on('framesent', ({ payload }) => {
      if (typeof payload === 'string') sent.push(JSON.parse(payload));
    });
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string') received.push(JSON.parse(payload));
    });
  });
  const ticket = page.waitForResponse(
    (res) => res.url().endsWith('/v1/child/voice/tickets') && res.request().method() === 'POST',
  );
  await page.getByTestId('voice-toggle').click();
  expect((await ticket).status()).toBe(200);
  await expect.poll(() => sent).toContainEqual({ type: 'start', sampleRateHz: 16000 });
  await expect
    .poll(() => received, { timeout: 25_000 })
    .toContainEqual({ type: 'end', reason: 'error' });
  expect(received).not.toContainEqual(expect.objectContaining({ type: 'ready' }));
  await expect(page.getByTestId('voice-error')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('voice-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('voice-status')).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toBeEnabled();
});

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 1000 },
]) {
  test(`${viewport.name} room, chat, settings and tell fit without horizontal overflow`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await localChild(page, `c_visual_${viewport.name}_${Date.now()}`);
    for (const route of ['/', '/chat', '/settings', '/tell']) {
      await page.goto(route);
      const ready =
        route === '/'
          ? 'pet-room'
          : route === '/chat'
            ? 'msg-pet'
            : route === '/settings'
              ? 'source-voice'
              : 'choice-proxy';
      await expect(page.getByTestId(ready).first()).toBeVisible();
      if (route === '/settings') await expect(page.getByTestId('source-voice')).toBeEnabled();
      if (route === '/chat') {
        const composer = await page.getByTestId('chat-input').evaluate((input) => {
          const form = input.closest('form')!;
          const row = form.parentElement!.parentElement!;
          const bounds = (node: Element) => {
            const { left, right, width, top, bottom } = node.getBoundingClientRect();
            return { left, right, width, top, bottom };
          };
          return {
            row: bounds(row),
            input: bounds(input),
            send: bounds(row.querySelector('[data-testid="chat-send"]')!),
            voice: bounds(row.querySelector('[data-testid="voice-toggle"]')!),
            placeholderFits: (() => {
              const field = input as HTMLTextAreaElement;
              const style = getComputedStyle(field);
              const context = document.createElement('canvas').getContext('2d')!;
              context.font = `${style.fontSize} ${style.fontFamily}`;
              return (
                context.measureText(field.placeholder).width <=
                field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
              );
            })(),
          };
        });
        expect(composer.input.width).toBeGreaterThan(0);
        expect(composer.placeholderFits).toBe(true);
        if (viewport.name === 'mobile')
          expect(composer.input.bottom).toBeLessThanOrEqual(composer.send.top);
        else expect(composer.input.right).toBeLessThanOrEqual(composer.send.left);
        expect(composer.send.right).toBeLessThanOrEqual(composer.voice.left);
        expect(composer.voice.right).toBeLessThanOrEqual(composer.row.right + 1);
      }
      const dimensions = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
      }));
      expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
      const name = `${viewport.name}-${route === '/' ? 'room' : route.slice(1)}`;
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    }
  });
}
