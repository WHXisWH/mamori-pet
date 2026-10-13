import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// PRD「子どもへの見せ方」の2つの最低線の1つ：相談窓口への入口を全画面に常設する。
// 子ども側のページを1つずつ開き、ワンタップで相談先に行けることを確かめる。ページに /help への入口があるか、ページ自体に電話番号が載っていればよい。
const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080';

async function pairChild(page: Page) {
  const headers = { 'X-Dev-Guardian-Id': `g_help_${randomUUID()}` };
  expect((await page.request.post(`${API}/v1/families`, { headers, data: {} })).status()).toBe(201);
  for (const type of ['guardian_terms', 'guardian_sensitive'])
    await page.request.post(`${API}/v1/consents`, {
      headers,
      data: { type, documentVersion: 'v0.1' },
    });
  const created = await page.request.post(`${API}/v1/children`, {
    headers,
    data: { nickname: 'テストそら', gradeBand: 'low' },
  });
  const { childId } = (await created.json()) as { childId: string };
  const pairing = await page.request.post(`${API}/v1/children/${childId}/pairing-codes`, {
    headers,
  });
  const { code } = (await pairing.json()) as { code: string };
  await page.goto('/pair');
  await page.getByTestId('pair-code').fill(code);
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('assent')).toBeVisible();
  for (let step = 0; step < 4; step++) await page.getByTestId('assent-next').click();
  await page.getByTestId('pick-moko').click();
  await page.getByTestId('choose-go').click();
  await expect(page.getByTestId('pet-room')).toBeVisible();
}

async function expectHelpReachable(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  const entry = page.locator('a[href="/help"]:visible');
  const phones = page.locator('a[href^="tel:"]:visible');
  await expect
    .poll(async () => (await entry.count()) + (await phones.count()), { message: path })
    .toBeGreaterThan(0);
}

// アクセシビリティ（WCAG 2 A/AA）：色のコントラスト以外の問題はすべて失敗にする。
// 白文字とブランドの緑 #7fb77e（相談窓口に電話する）・ブランドの青 #6b9ac4（主ボタン）の組み合わせはコントラストが足りない。
// 色を変えるかはデザイン上の判断で、まだ決まっていない。それまではページごとに今の件数を登録し、減るのはよいが増えるのは認めない。
const CONTRAST_BASELINE: Record<string, number> = {
  '/help': 11,
  '/offline': 1,
  '/safe': 18,
  '/': 1,
  '/island': 1,
  '/requests': 1,
  '/draw/self': 1,
  '/tell': 2,
  '/settings': 2,
};
const axeReport: Record<
  string,
  { id: string; impact: string | null | undefined; nodes: number }[]
> = {};

async function scan(page: Page, path: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  axeReport[path] = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.length,
  }));
  const others = result.violations.filter((v) => v.id !== 'color-contrast');
  expect(
    others.map((v) => `${v.id}: ${v.help}`),
    path,
  ).toEqual([]);
  const contrast = result.violations.find((v) => v.id === 'color-contrast')?.nodes.length ?? 0;
  expect(contrast, `${path} color-contrast`).toBeLessThanOrEqual(CONTRAST_BASELINE[path] ?? 0);
}

test.afterAll(() => {
  if (process.env['AXE_REPORT'])
    writeFileSync(process.env['AXE_REPORT'], JSON.stringify(axeReport, null, 2));
});

test('before pairing, every page offers help', async ({ page }) => {
  for (const path of ['/pair', '/help', '/offline', '/safe']) {
    await expectHelpReachable(page, path);
    await scan(page, path);
  }
});

test('after pairing, every page offers help', async ({ page }) => {
  await pairChild(page);
  for (const path of [
    '/',
    '/chat',
    '/mood',
    '/island',
    '/requests',
    '/draw/self',
    '/draw/story',
    '/tell',
    '/settings',
    '/help',
    '/safe',
  ]) {
    await expectHelpReachable(page, path);
    await scan(page, path);
  }
});
