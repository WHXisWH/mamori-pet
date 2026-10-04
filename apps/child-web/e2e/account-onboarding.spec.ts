import { expect, test } from '@playwright/test';

const guardianUrl = process.env['PW_GUARDIAN_URL'] ?? 'http://localhost:3101';
const api = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080';

test('new local guardian, separate consents, encrypted child, one-use pairing and withdrawal', async ({
  page,
  context,
  request,
}) => {
  await page.goto(`${guardianUrl}/signup`);
  await page.evaluate(() => localStorage.removeItem('mamori-guardian-id'));
  await page.reload();
  await page.getByLabel('表示名（任意）').fill('合成テスト保護者');
  await page.getByRole('button', { name: 'ローカル家族を登録' }).click();
  await expect(page).toHaveURL(/\/consent$/);
  await page.getByRole('checkbox').nth(0).check();
  await expect(page.getByRole('button', { name: '同意して子どもの登録へ' })).toBeDisabled();
  await page.getByRole('checkbox').nth(1).check();
  await expect(page.getByRole('button', { name: '同意して子どもの登録へ' })).toBeDisabled();
  await page.getByRole('checkbox').nth(2).check();
  await page.getByRole('button', { name: '同意して子どもの登録へ' }).click();
  await expect(page).toHaveURL(/\/children\/new$/);
  await page.getByLabel('ニックネーム').fill('テストそら');
  await page.getByRole('combobox', { name: '学年', exact: true }).selectOption('low');
  await page.getByRole('button', { name: '登録してペアリングへ' }).click();
  await expect(page).toHaveURL(/\/children\/[^/]+\/pairing$/);
  const childId = new URL(page.url()).pathname.split('/')[2]!;
  await page.getByRole('button', { name: 'ペアリング番号を発行' }).click();
  const code = await page.getByTestId('issued-pair-code').innerText();
  expect(code).toMatch(/^\d{6}$/);
  const child = await context.newPage();
  await child.goto('/pair');
  await child.getByTestId('pair-code').fill(code);
  await child.getByTestId('pair-submit').click();
  await expect(child.getByTestId('assent')).toBeVisible();
  expect((await request.post(`${api}/v1/child/pair`, { data: { code } })).status()).toBe(410);
  expect(
    (
      await request.get(`${api}/v1/child/home`, { headers: { 'X-Dev-Child-Id': childId } })
    ).status(),
  ).toBe(403);
  for (let step = 0; step < 4; step++) await child.getByTestId('assent-next').click();
  await expect(child.getByTestId('character-picker')).toBeVisible();
  await child.getByTestId('pick-pokke').click();
  await child.getByTestId('choose-go').click();
  await expect(child.getByTestId('pet-room')).toBeVisible();
  await expect(child.locator('html')).toHaveAttribute('data-grade', 'low');
  await page.goto(`${guardianUrl}/children`);
  await expect(page.getByRole('heading', { name: 'テストそら' })).toBeVisible();
  await page.goto(`${guardianUrl}/consent`);
  await page.getByRole('button', { name: '撤回する', exact: true }).first().click();
  await page.getByRole('button', { name: '撤回して利用を停止' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const response = await request.get(`${api}/v1/child/home`, {
    headers: { 'X-Dev-Child-Id': childId },
  });
  expect([403, 404]).toContain(response.status());
  await child.close();
});
