import { randomUUID } from 'node:crypto';
import type { GradeBand, ChildHomeRes, NotificationsRes, AgentSummaryRes } from '@ijime/api-types';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080';
const GUARDIAN = process.env['PW_GUARDIAN_URL'] ?? 'http://localhost:3101';

test.beforeAll(() => {
  for (const url of [API, GUARDIAN])
    expect(['localhost', '127.0.0.1']).toContain(new URL(url).hostname);
});

async function family(page: Page, gradeBand: GradeBand = 'high') {
  const guardianId = `g_core_${randomUUID()}`;
  const guardianHeaders = { 'X-Dev-Guardian-Id': guardianId };
  expect(
    (
      await page.request.post(`${API}/v1/families`, {
        headers: guardianHeaders,
        data: { displayName: '合成テスト保護者' },
      })
    ).status(),
  ).toBe(201);
  for (const type of ['guardian_terms', 'guardian_sensitive'])
    expect(
      (
        await page.request.post(`${API}/v1/consents`, {
          headers: guardianHeaders,
          data: { type, documentVersion: 'v0.1' },
        })
      ).status(),
    ).toBe(201);
  const created = await page.request.post(`${API}/v1/children`, {
    headers: guardianHeaders,
    data: { nickname: 'テストそら', gradeBand },
  });
  expect(created.status()).toBe(201);
  const { childId } = (await created.json()) as { childId: string };
  const paired = await page.request.post(`${API}/v1/children/${childId}/pairing-codes`, {
    headers: guardianHeaders,
  });
  expect(paired.status()).toBe(201);
  const { code } = (await paired.json()) as { code: string };
  await page.goto('/pair');
  await page.getByTestId('pair-code').fill(code);
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('assent')).toBeVisible();
  for (let step = 0; step < 4; step++) await page.getByTestId('assent-next').click();
  await page.getByTestId('pick-moko').click();
  await page.getByTestId('choose-go').click();
  await expect(page.getByTestId('pet-room')).toBeVisible();
  return { childId, guardianId, guardianHeaders, childHeaders: { 'X-Dev-Child-Id': childId } };
}

async function say(page: Page, text: string) {
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-send').click();
}

async function capture(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('guardian deletion is registered locally, accepts a retry and blocks further child access', async ({
  page,
  context,
}, info) => {
  const f = await family(page);
  await page.goto('/chat');
  await say(page, '今日は絵をかいたよ');
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
  const guardian = await context.newPage();
  await guardian.goto(GUARDIAN);
  await guardian.evaluate((id) => localStorage.setItem('mamori-guardian-id', id), f.guardianId);
  await guardian.goto(`${GUARDIAN}/settings`);
  const section = guardian.getByTestId('guardian-deletion');
  await expect(section).toBeVisible();
  guardian.once('dialog', (dialog) => dialog.dismiss());
  await section.getByRole('button', { name: '削除を依頼' }).click();
  await expect(section.getByRole('status')).toHaveCount(0);
  expect((await page.request.get(`${API}/v1/child/home`, { headers: f.childHeaders })).ok()).toBe(
    true,
  );
  guardian.once('dialog', (dialog) => dialog.accept());
  const response = guardian.waitForResponse((res) => res.url().endsWith('/data-deletion-requests'));
  await section.getByRole('button', { name: '削除を依頼' }).click();
  const accepted = await response;
  expect(accepted.status()).toBe(202);
  await expect(section.getByRole('status')).toContainText('削除依頼を受け付けました');
  const retry = await page.request.post(`${API}/v1/children/${f.childId}/data-deletion-requests`, {
    headers: f.guardianHeaders,
  });
  expect(retry.status()).toBe(202);
  expect(await retry.json()).toEqual(await accepted.json());
  for (const path of ['home', 'memories', 'chat/sessions']) {
    const denied = await page.request.get(`${API}/v1/child/${path}`, { headers: f.childHeaders });
    expect([403, 404]).toContain(denied.status());
  }
  await capture(guardian, info, 'guardian-deletion-accepted');
});

for (const operation of ['open', 'delete'] as const) {
  test(`chat remains usable after ${operation} during a pending reply`, async ({ page }, info) => {
    const f = await family(page);
    const older = await page.request.post(`${API}/v1/child/chat/sessions`, {
      headers: f.childHeaders,
    });
    expect(older.status()).toBe(201);
    const oldId = ((await older.json()) as { sessionId: string }).sessionId;
    const created = page.waitForResponse(
      (res) => res.request().method() === 'POST' && res.url().endsWith('/chat/sessions'),
    );
    await page.goto('/chat');
    const currentId = ((await (await created).json()) as { sessionId: string }).sessionId;
    const pattern = `${API}/v1/child/chat/sessions/*/messages`;
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intercepted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let first = true;
    // Delay only the first POST to deterministically exercise cancellation. Subsequent chat
    // and all session operations use the real local API and scripted ADK agent.
    await page.route(pattern, async (route) => {
      if (route.request().method() !== 'POST' || !first) return route.continue();
      first = false;
      entered();
      await held;
      await route.abort().catch(() => {});
    });
    try {
      await say(page, '返事を待っているよ');
      await intercepted;
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'sending');
      await page.getByTestId('session-manager').click();
      await page
        .getByTestId(operation === 'open' ? `open-session-${oldId}` : `delete-session-${currentId}`)
        .click();
      await expect(page.getByTestId('chat-input')).toBeEnabled();
      await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
      release();
      await say(page, 'きょうは たのしかった！');
      await expect(page.getByTestId('msg-pet').last()).toContainText('いいね');
      await expect(page.getByTestId('chat-input')).toBeEnabled();
      await capture(page, info, `chat-${operation}-recovered`);
    } finally {
      release();
      await page.unrouteAll({ behavior: 'wait' });
    }
  });
}

test('a generated summary requires child approval and can be forgotten', async ({ page }, info) => {
  const f = await family(page);
  await page.goto('/chat');
  for (let turn = 0; turn < 6; turn++) {
    const response = page.waitForResponse(
      (res) => res.request().method() === 'POST' && /\/messages$/.test(new URL(res.url()).pathname),
    );
    await say(page, '今日は絵をかいたよ');
    expect((await response).ok()).toBe(true);
    await (await response).finished();
    await expect(page.getByTestId('chat-input')).toBeEnabled();
  }
  const read = async () => {
    const res = await page.request.get(`${API}/v1/child/agent-summary`, {
      headers: f.childHeaders,
    });
    expect(res.ok()).toBe(true);
    return ((await res.json()) as AgentSummaryRes).summary;
  };
  await expect.poll(async () => (await read())?.approved, { timeout: 10_000 }).toBe(false);
  await page.goto('/settings');
  const section = page.getByTestId('agent-summary');
  await expect(section.getByTestId('summary-accept')).toBeVisible();
  await capture(page, info, 'summary-before-approval');
  await page.setViewportSize({ width: 1440, height: 900 });
  await capture(page, info, 'summary-desktop');
  await page.setViewportSize({ width: 393, height: 851 });
  await section.getByTestId('summary-accept').click();
  await expect.poll(async () => (await read())?.approved).toBe(true);
  await page.reload();
  await expect(section.getByText('おぼえている おはなし')).toBeVisible();
  await expect(section.getByTestId('summary-accept')).toHaveCount(0);
  await section.getByTestId('summary-reject').click();
  await expect.poll(read).toBeNull();
  await page.reload();
  await expect(section).toHaveCount(0);
});

async function installLocalSpeechSpy(page: Page) {
  await page.addInitScript(() => {
    const spoken: string[] = [];
    Object.defineProperty(window, '__spoken', { value: spoken });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: class {
        text: string;
        constructor(text: string) {
          this.text = text;
        }
      },
    });
    Object.defineProperty(window, 'speechSynthesis', {
      value: {
        cancel() {},
        getVoices: () => [{ lang: 'ja-JP', localService: true }],
        speak: (utterance: { text: string }) => spoken.push(utterance.text),
      },
    });
  });
}

// Business requests use the real local API + ADK + Firestore emulator, not route mocks.
test('dispatch queue generates a persisted home greeting and respects disabled slots', async ({
  page,
}, info) => {
  const f = await family(page);
  const home = async () => {
    const response = await page.request.get(`${API}/v1/child/home`, { headers: f.childHeaders });
    expect(response.ok()).toBe(true);
    return (await response.json()) as ChildHomeRes;
  };
  expect((await home()).greeting.source).toBe('template');
  expect(
    (
      await page.request.put(`${API}/v1/child/preferences`, {
        headers: f.childHeaders,
        data: { gradeBand: 'high', proactiveEnabled: true, proactiveSlots: ['after_school'] },
      })
    ).ok(),
  ).toBe(true);
  const dispatch = (slot: string) =>
    page.request.post(`${API}/internal/proactive-turns/dispatch`, {
      headers: { 'X-Internal-Token': 'local-proactive' },
      data: { slot },
    });
  const skipped = await dispatch('morning');
  expect(skipped.ok()).toBe(true);
  expect((await skipped.json()).skipped).toBeGreaterThan(0);
  expect((await home()).greeting.source).toBe('template');
  expect((await dispatch('after_school')).ok()).toBe(true);
  await expect.poll(async () => (await home()).greeting.source, { timeout: 15_000 }).toBe('agent');
  const greeting = (await home()).greeting;
  expect(greeting.text).toContain('おかえり');
  await page.reload();
  await expect(page.getByTestId('greeting-bubble')).toHaveAttribute('data-source', 'agent');
  await expect(page.getByTestId('greeting-bubble')).toContainText(greeting.text);
  expect((await dispatch('after_school')).ok()).toBe(true);
  expect((await home()).greeting).toEqual(greeting);
  const sessions = await page.request.get(`${API}/v1/child/chat/sessions`, {
    headers: f.childHeaders,
  });
  expect(sessions.ok()).toBe(true);
  expect((await sessions.json()).items).toEqual([]);
  await capture(page, info, 'proactive-home');
});

for (const grade of ['low', 'high', 'jhs'] as const) {
  test(`${grade}: pairing, conversation, supportive response and child-requested help`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await family(page, grade);
    await page.getByTestId('tile-chat').click();
    await say(page, 'きょうは たのしかった！');
    await expect(page.getByTestId('msg-pet').last()).toContainText('いいね');
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
    await say(page, 'みんなに 無視された');
    await expect(page.getByTestId('msg-pet').last()).toContainText('つらかったね');
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
    await expect(page.getByTestId('offer-tell-adult')).toHaveCount(0);
    await say(page, 'おとなに はなしたい');
    await expect(page.getByTestId('offer-tell-adult')).toBeVisible();
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
    await capture(page, info, `${grade}-chat-help`);
    await page.getByTestId('offer-tell-adult').click();
    await expect(page).toHaveURL(/\/tell\?consultationId=/);
    await page.getByTestId('choice-not_now').click();
    await expect(page.getByTestId('tell-result')).toHaveAttribute('data-choice', 'not_now');
    expect(errors).toEqual([]);
  });
}

test('crisis input reaches the guardian guide without sharing the transcript; acknowledgement survives reload', async ({
  page,
  context,
}, info) => {
  const f = await family(page);
  const privateText = `合成確認${Date.now()} もう消えたい`;
  await page.goto('/chat');
  await say(page, privateText);
  await expect(page).toHaveURL(/\/safe$/);
  await expect(page.getByTestId('safe-mode')).toBeVisible();
  await expect(page.getByTestId('safe-call')).toHaveCount(4);
  await expect(page.locator('[data-testid="safe-call"][href="tel:110"]')).toBeVisible();
  await expect(page.locator('[data-testid="safe-call"][href="tel:119"]')).toBeVisible();
  await capture(page, info, 'child-safe');
  const list = async () => {
    const response = await page.request.get(`${API}/v1/notifications`, {
      headers: f.guardianHeaders,
    });
    expect(response.ok()).toBe(true);
    return (await response.json()) as NotificationsRes;
  };
  await expect
    .poll(async () => (await list()).items.some((n) => n.kind === 'crisis'), { timeout: 15_000 })
    .toBe(true);
  const notice = (await list()).items.find((n) => n.kind === 'crisis')!;
  const detail = await page.request.get(`${API}/v1/notifications/${notice.id}`, {
    headers: f.guardianHeaders,
  });
  const body = await detail.json();
  expect(body).not.toHaveProperty('level');
  expect(JSON.stringify(body)).not.toContain(privateText);
  const guardian = await context.newPage();
  await guardian.goto(GUARDIAN);
  await guardian.evaluate((id) => localStorage.setItem('mamori-guardian-id', id), f.guardianId);
  await guardian.goto(`${GUARDIAN}/crisis/${notice.id}`);
  await expect(guardian.getByTestId('notification-detail')).toBeVisible();
  await expect(guardian.getByTestId('notification-detail')).toContainText('できること');
  await expect(
    guardian.getByTestId('notification-detail').locator('a[href="tel:110"]'),
  ).toBeVisible();
  await expect(
    guardian.getByTestId('notification-detail').locator('a[href="tel:119"]'),
  ).toBeVisible();
  await capture(guardian, info, 'guardian-crisis-guide');
  await guardian.getByTestId('notification-ack').click();
  await expect(guardian.getByTestId('notification-acknowledged')).toBeVisible();
  await guardian.reload();
  await expect(guardian.getByTestId('notification-acknowledged')).toBeVisible();
});

test('low grade help and safety text have readings and manual local speech', async ({
  page,
}, info) => {
  await installLocalSpeechSpy(page);
  await family(page, 'low');
  await page.goto('/help');
  await expect(page.locator('#help-title ruby rt')).toHaveText('そうだん');
  await expect(page.getByTestId('hotline-list').locator('ruby rt').first()).toBeVisible();
  await expect(page.locator('[data-testid="hotline-call"][href="tel:110"]')).toBeVisible();
  await expect(page.locator('[data-testid="hotline-call"][href="tel:119"]')).toBeVisible();
  await page.getByTestId('read-aloud').first().click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join('\n')),
    )
    .toContain('SOS');
  await capture(page, info, 'low-help-readings');
  await page.goto('/safe');
  await expect(page.getByTestId('safe-call').first().locator('ruby')).not.toHaveCount(0);
  await page.getByTestId('read-aloud').click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.join('\n')),
    )
    .toContain('たすけて');
  await capture(page, info, 'low-safety-reading');
});

test('synthetic model outage pauses the message, keeps help in reach and is not treated as a crisis', async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await family(page, 'low');
  await page.goto('/chat');
  await say(page, '[local-e2e:model-unavailable]');
  // （2026-10-07 決定）「もう一度言って」は出さない。再確認の間はメッセージを待機させ、相談先は表示したままにする。
  await expect(page.getByTestId('pending-review-help')).toBeVisible();
  await expect(page.getByTestId('pending-review-message')).toContainText('まってね');
  for (const phone of ['110', '119', '189'])
    await expect(
      page.getByTestId('pending-review-resources').locator(`a[href="tel:${phone}"]`),
    ).toBeVisible();
  await expect(page.getByTestId('help-button')).toBeVisible();
  await expect(page.getByTestId('safe-mode')).toHaveCount(0);
  await expect(page).toHaveURL(/\/chat\/?$/);
  await capture(page, info, 'model-unavailable');
  expect(errors).toEqual([]);
});

test('synthetic family-harm classification keeps 189 and 110 available and does not notify the guardian', async ({
  page,
}, info) => {
  const f = await family(page, 'low');
  await page.goto('/chat');
  await say(page, '[local-e2e:family-harm] お父さんに殴られている');
  await expect(page).toHaveURL(/\/safe$/);
  await expect(page.getByTestId('safe-call').first()).toHaveAttribute('href', 'tel:189');
  await expect(page.getByTestId('safe-call')).toHaveCount(3);
  await expect(page.locator('[data-testid="safe-call"][href="tel:110"]')).toBeVisible();
  await expect(page.locator('[data-testid="safe-call"][href="tel:119"]')).toBeVisible();
  await expect(page.getByTestId('adult-yes')).toHaveCount(0);
  const notifications = await page.request.get(`${API}/v1/notifications`, {
    headers: f.guardianHeaders,
  });
  expect((await notifications.json()).items).toEqual([]);
  await capture(page, info, 'family-safety');
});
