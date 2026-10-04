import { expect, test, type Page } from '@playwright/test';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080';
const GUARDIAN = process.env['PW_GUARDIAN_URL'] ?? 'http://localhost:3101';

test.describe.configure({ mode: 'serial' });

async function family(page: Page) {
  const guardianId = `g_functional_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const headers = { 'X-Dev-Guardian-Id': guardianId };
  expect(
    (
      await page.request.post(`${API}/v1/families`, {
        headers,
        data: { displayName: '動作確認用保護者' },
      })
    ).status(),
  ).toBe(201);
  for (const type of ['guardian_terms', 'guardian_sensitive'])
    expect(
      (
        await page.request.post(`${API}/v1/consents`, {
          headers,
          data: { type, documentVersion: 'v0.1' },
        })
      ).status(),
    ).toBe(201);
  const children: { childId: string; nickname: string }[] = [];
  for (const nickname of ['さくら', 'はる']) {
    const response = await page.request.post(`${API}/v1/children`, {
      headers,
      data: { nickname, gradeBand: 'high' },
    });
    expect(response.status()).toBe(201);
    children.push({ ...((await response.json()) as { childId: string }), nickname });
  }
  await page.addInitScript((id) => localStorage.setItem('mamori-guardian-id', id), guardianId);
  await page.goto(GUARDIAN);
  await expect(page.getByTestId('guardian-child-select')).toBeVisible();
  await page.getByTestId('guardian-child-select').selectOption(children[0]!.childId);
  return { headers, children, guardianId };
}

test('guardian selects children and creates/removes real multi-child context without invented weekly data', async ({
  page,
}) => {
  const t = await family(page);
  await expect(page.getByTestId('weekly-empty')).toBeVisible();
  await page.getByTestId('guardian-child-select').selectOption(t.children[1]!.childId);
  await expect(page.getByTestId('weekly-empty')).toBeVisible();
  await page.getByRole('link', { name: '予定・できごと', exact: true }).click();
  await expect(page.getByTestId('guardian-child-select')).toHaveValue(t.children[1]!.childId);
  await page.getByRole('button', { name: '記録を追加' }).click();
  await page.getByRole('checkbox', { name: 'さくら', exact: true }).check();
  await page.getByRole('combobox', { name: '種類', exact: true }).selectOption('school_event');
  await page.getByLabel('開始日', { exact: true }).fill('2026-10-05');
  await page.getByLabel('終了日', { exact: true }).fill('2026-10-06');
  const saved = page.waitForResponse(
    (res) => res.url().endsWith('/v1/context-events') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  expect((await saved).status()).toBe(201);
  await expect(page.getByTestId('context-event')).toHaveCount(1);
  await page.reload();
  await page.getByTestId('guardian-child-select').selectOption(t.children[0]!.childId);
  await expect(page.getByTestId('context-event')).toContainText('学校行事');
  for (const child of t.children) {
    const response = await page.request.get(`${API}/v1/context-events?childId=${child.childId}`, {
      headers: t.headers,
    });
    const body = (await response.json()) as { items: { eventId: string; childIds: string[] }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.childIds.sort()).toEqual(t.children.map((c) => c.childId).sort());
  }
  const removed = page.waitForResponse(
    (res) => res.url().includes('/v1/context-events/') && res.request().method() === 'DELETE',
  );
  await page.getByRole('button', { name: 'この予定・できごとを削除' }).click();
  await page.getByRole('button', { name: '削除する', exact: true }).click();
  expect((await removed).status()).toBe(204);
  await expect(page.getByTestId('context-empty')).toBeVisible();
  await expect(page.getByTestId('context-result')).toContainText('削除しました');
  await page.reload();
  await expect(page.getByTestId('context-empty')).toBeVisible();
});

test('failed context save preserves input and never reports success', async ({ page, context }) => {
  await family(page);
  await page.goto(`${GUARDIAN}/context`);
  await expect(page.getByTestId('context-empty')).toBeVisible();
  await page.getByRole('button', { name: '記録を追加' }).click();
  await page.getByRole('combobox', { name: '種類', exact: true }).selectOption('travel');
  await context.setOffline(true);
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await expect(page.getByTestId('context-save-error')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '種類', exact: true })).toHaveValue('travel');
  await expect(page.getByTestId('context-result')).toHaveCount(0);
  await context.setOffline(false);
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await expect(page.getByTestId('context-result')).toContainText('登録しました');
});

test('guardian saves notification contacts to the real API and a 204 is a successful save', async ({
  page,
}) => {
  const t = await family(page);
  await page.goto(`${GUARDIAN}/settings`);
  await expect(page.getByTestId('notification-settings')).toBeVisible();
  await page.getByRole('checkbox', { name: 'SMS（緊急連絡）', exact: true }).check();
  await page.getByLabel('電話番号（国番号付き）').fill('+819012345678');
  const saved = page.waitForResponse(
    (res) => res.url().endsWith('/notify-settings') && res.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: '設定を保存' }).click();
  expect((await saved).status()).toBe(204);
  await expect(page.getByTestId('notification-settings-saved')).toContainText(
    '送信確認はしていません',
  );
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'SMS（緊急連絡）', exact: true })).toBeChecked();
  await expect(page.getByLabel('電話番号（国番号付き）')).toHaveValue('+819012345678');
  const result = await page.request.get(`${API}/v1/guardians/me/notify-settings`, {
    headers: t.headers,
  });
  expect(await result.json()).toMatchObject({
    channels: ['webpush', 'sms'],
    phoneE164: '+819012345678',
  });
  await expect(page.getByTestId('push-unconfigured')).toBeVisible();
});

test('unconfigured Google Calendar is not presented as a successful connection', async ({
  page,
}) => {
  await family(page);
  await page.goto(`${GUARDIAN}/context`);
  await expect(page.getByTestId('calendar-connection')).toBeVisible();
  const request = page.waitForResponse((res) => res.url().endsWith('/v1/calendar/connect'));
  await page.getByRole('button', { name: 'Google カレンダーを連携', exact: true }).click();
  expect((await request).ok()).toBe(false);
  await expect(page.getByTestId('calendar-unavailable')).toContainText('連携は完了していません');
  expect(new URL(page.url()).origin).toBe(new URL(GUARDIAN).origin);
});

test('calendar selection and disconnect UI obey the adapter contract with explicit provider fixtures', async ({
  page,
}) => {
  await family(page);
  let selected = ['school'];
  let connected = true;
  const cors = {
    'access-control-allow-origin': new URL(GUARDIAN).origin,
    'access-control-allow-headers': 'Content-Type, X-Dev-Guardian-Id',
    'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
  };
  await page.route(`${API}/v1/calendar/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (request.method() === 'GET') {
      if (!connected)
        return route.fulfill({
          status: 404,
          headers: cors,
          json: { error: { code: 'NOT_FOUND', message: '未連携' } },
        });
      return route.fulfill({
        headers: cors,
        json: {
          items: [
            { calendarId: 'school', name: '学校', selected: selected.includes('school') },
            { calendarId: 'family', name: '家族', selected: selected.includes('family') },
          ],
        },
      });
    }
    if (request.method() === 'PUT')
      selected = (request.postDataJSON() as { calendarIds: string[] }).calendarIds;
    if (request.method() === 'DELETE') connected = false;
    return route.fulfill({ status: 204, headers: cors });
  });
  await page.goto(`${GUARDIAN}/context`);
  await page.getByRole('checkbox', { name: '家族', exact: true }).check();
  await page.getByRole('button', { name: '選択を保存', exact: true }).click();
  await expect(page.getByTestId('calendar-result')).toContainText('保存しました');
  expect(selected.sort()).toEqual(['family', 'school']);
  await page.getByRole('button', { name: '連携を解除', exact: true }).click();
  await page.getByRole('button', { name: '解除する', exact: true }).click();
  await expect(page.getByTestId('calendar-disconnected')).toBeVisible();
  expect(connected).toBe(false);
});

test('real crisis remains visible across guardian pages and disappears only after acknowledgement', async ({
  page,
}) => {
  const t = await family(page);
  const childId = t.children[0]!.childId;
  const childHeaders = { 'X-Dev-Child-Id': childId };
  expect(
    (
      await page.request.post(`${API}/v1/child/assent`, {
        headers: childHeaders,
        data: {
          documentVersion: 'v0.1',
          dataSources: {
            voice: false,
            typing: false,
            artwork_save: false,
            home_checkin: true,
            calendar: true,
          },
        },
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
  const session = await page.request.post(`${API}/v1/child/chat/sessions`, {
    headers: childHeaders,
    data: {},
  });
  expect(session.status()).toBe(201);
  const { sessionId } = (await session.json()) as { sessionId: string };
  const crisis = await page.request.post(`${API}/v1/child/chat/sessions/${sessionId}/messages`, {
    headers: childHeaders,
    data: { text: 'もう死にたい', inputMode: 'typed', clientSentAt: new Date().toISOString() },
  });
  expect(crisis.ok()).toBe(true);
  expect(await crisis.text()).toContain('event: crisis');
  let id = '';
  await expect
    .poll(async () => {
      const response = await page.request.get(`${API}/v1/notifications`, { headers: t.headers });
      const data = (await response.json()) as {
        items: { id: string; childId: string; kind: string }[];
      };
      id = data.items.find((item) => item.childId === childId && item.kind === 'crisis')?.id ?? '';
      return id;
    })
    .not.toBe('');
  for (const route of ['/', '/context', '/settings', `/notifications/${id}`]) {
    await page.goto(`${GUARDIAN}${route}`);
    await expect(page.getByTestId('crisis-banner')).toBeVisible();
    await expect(page.getByTestId('local-test-mode')).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText('もう死にたい');
  }
  await page.getByTestId('notification-ack').click();
  await expect(page.getByTestId('notification-acknowledged')).toBeVisible();
  await expect(page.getByTestId('crisis-banner')).toHaveCount(0);
  await page.goto(`${GUARDIAN}/context`);
  await expect(page.getByTestId('crisis-banner')).toHaveCount(0);
});

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 1000 },
]) {
  test(`guardian ${viewport.name} weekly/context/settings layout uses real projections without overflow`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    const headers = { 'X-Dev-Guardian-Id': 'g_dev' };
    const report = await page.request.get(`${API}/v1/children/c_dev/weekly-reports`, { headers });
    expect(report.status()).toBe(200);
    const body = (await report.json()) as {
      weekId: string;
      vitality: { activeDays: number };
      summaryText: string;
    };
    expect(Object.keys(body).sort()).toEqual(['summaryText', 'vitality', 'weekId']);
    for (const route of ['/', '/context', '/settings']) {
      await page.goto(`${GUARDIAN}${route}`);
      await expect(page.getByTestId('local-test-mode')).toHaveCount(1);
      if (route === '/') {
        await page.getByTestId('guardian-child-select').selectOption('c_dev');
        await expect(page.getByTestId('weekly-active-days')).toContainText(
          String(body.vitality.activeDays),
        );
        if (body.summaryText)
          await expect(page.getByTestId('weekly-summary')).toHaveText(body.summaryText);
      } else if (route === '/context') {
        await expect(page.getByTestId('calendar-connection')).toBeVisible();
        await page.getByRole('button', { name: '記録を追加' }).click();
        await expect(page.getByTestId('context-form')).toBeVisible();
      } else await expect(page.getByTestId('notification-settings')).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);
      const path = info.outputPath(
        `guardian-${viewport.name}-${route === '/' ? 'home' : route.slice(1)}.png`,
      );
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await info.attach(`guardian-${viewport.name}-${route}`, { path, contentType: 'image/png' });
    }
  });
}
