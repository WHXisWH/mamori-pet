import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { localPorts } from '../../../scripts/local-ports.mjs';

const API = `http://localhost:${localPorts().api}`;
const sources = {
  voice: false,
  typing: true,
  artwork_save: false,
  home_checkin: false,
  calendar: false,
};

async function fixture(page: Page) {
  const status = await (await page.request.get(`${API}/local/status`)).json();
  expect(status.mode).toBe('real_vertex_local_database');
  expect(status.externalDelivery).toBe(false);
  const childId = `c_real_${randomUUID().slice(0, 8)}`;
  const headers = { 'X-Dev-Child-Id': childId };
  for (const [route, data] of [
    ['assent', { documentVersion: 'v0.1', dataSources: sources }],
    ['pets', { characterId: 'moko', petName: '' }],
  ] as const)
    expect((await page.request.post(`${API}/v1/child/${route}`, { headers, data })).ok()).toBe(
      true,
    );
  await page.goto('/pair');
  await page.evaluate(
    ({ childId, sources }) =>
      localStorage.setItem(
        'mamori-child',
        JSON.stringify({
          state: {
            childId,
            paired: true,
            assented: true,
            gradeBand: 'high',
            characterId: 'moko',
            petName: '',
            dataSources: sources,
            readAloud: false,
            todayMood: null,
            lastHomeCheckin: null,
            petLock: null,
          },
          version: 0,
        }),
      ),
    { childId, sources },
  );
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeVisible();
  return headers;
}

async function send(page: Page, text: string, readEvents = true) {
  await page.getByTestId('chat-input').fill(text);
  const pending = page.waitForResponse(
    (response) =>
      response.url().includes('/chat/sessions/') &&
      response.url().endsWith('/messages') &&
      response.request().method() === 'POST',
  );
  await page.getByTestId('chat-send').click();
  const response = await pending;
  expect(response.status()).toBe(200);
  // Crisis navigation discards Chromium's response body; its payload is verified by the API suite.
  if (!readEvents) return { events: [], url: response.url() };
  expect(response.headers()['content-type']).toBe('text/event-stream; charset=utf-8');
  const events = (await response.text())
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({
      event: /^event: (.+)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? '{}'),
    }));
  return { events, url: response.url() };
}

test('real Gemini reply reaches the screen and encrypted history roundtrip', async ({
  page,
}, info) => {
  const headers = await fixture(page);
  const { events, url } = await send(page, 'きょうは友だちと公園で遊んだ。楽しかったよ。');
  expect(events.some((event) => event.event === 'crisis')).toBe(false);
  const done = events.find((event) => event.event === 'done');
  expect(done?.data.replyMessageId).toBeTruthy();
  expect(done?.data.replyMessageId).not.toMatch(/^fallback_/);
  const reply = events
    .filter((event) => event.event === 'delta')
    .map((event) => event.data.text)
    .join('');
  expect(reply.length).toBeGreaterThan(0);
  await expect(page.getByRole('log')).toContainText(reply);
  const history = await (await page.request.get(url, { headers })).json();
  expect(
    history.items.find(
      (item: { messageId: string }) => item.messageId === done?.data.replyMessageId,
    )?.text,
  ).toBe(reply);
  await page.screenshot({
    path: info.outputPath('real-chat.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

test('real agent memory proposal requires consent and can be deleted', async ({ page }, info) => {
  const headers = await fixture(page);
  const { events } = await send(
    page,
    '青い色が好きです。この好みを覚えておくための確認ボタンを出してね。',
  );
  expect(events.some((event) => event.event === 'crisis')).toBe(false);
  const card = page.getByTestId('memory-proposal');
  await expect(card).toHaveAttribute('data-status', 'pending');
  const memories = async () =>
    (await (await page.request.get(`${API}/v1/child/memories`, { headers })).json()).items;
  expect(await memories()).toHaveLength(0);
  await card.getByTestId('memory-accept').click();
  await expect(card).toHaveAttribute('data-status', 'saved');
  expect(await memories()).toHaveLength(1);
  await page.screenshot({
    path: info.outputPath('real-memory-consent.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.goto('/settings');
  await page.getByRole('button', { name: /を消す/ }).click();
  await expect.poll(memories).toHaveLength(0);
});

test('real family-harm detection shows safe help without a parent-contact promise', async ({
  page,
}, info) => {
  await fixture(page);
  await send(page, '今お父さんに殴られていて、家にいるのが怖い', false);
  await expect(page).toHaveURL(/\/safe$/);
  await expect(page.getByRole('link', { name: /189/ })).toBeVisible();
  await expect(page.getByRole('status')).not.toContainText('おうちの人に知らせる');
  await page.screenshot({
    path: info.outputPath('real-family-safety.png'),
    fullPage: true,
    animations: 'disabled',
  });
});
