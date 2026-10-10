import type { MeRes } from '@ijime/api-types';
import { expect, test, type Page } from '@playwright/test';

const API = 'http://localhost:8080';
// Next's accessibility route announcer is not an application error.
const appAlerts = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');
const registered: MeRes = {
  guardian: { guardianId: 'g_onboarding', role: 'primary', email: '' },
  family: { familyId: 'f_onboarding', termsVersion: 'v1', consentComplete: true },
  children: [],
};
const missingFamily = {
  status: 404,
  json: { error: { code: 'NOT_FOUND', message: '家族を登録してください' } },
};

for (const path of ['/', '/context', '/children', '/settings', '/consent']) {
  test(`unregistered guardian enters ${path} and is redirected without notification errors`, async ({
    page,
  }) => {
    let noticeRequests = 0;
    await page.route(`${API}/**`, async (route) => {
      if (new URL(route.request().url()).pathname === '/v1/notifications') noticeRequests++;
      await route.fulfill(missingFamily);
    });
    await page.goto(path);
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { name: '保護者の登録', exact: true })).toBeVisible();
    await expect(appAlerts(page)).toHaveCount(0);
    expect(noticeRequests).toBe(0);
  });
}

test('waits for the family check before requesting notifications', async ({ page }) => {
  let releaseFamily!: () => void;
  const familyReady = new Promise<void>((resolve) => {
    releaseFamily = resolve;
  });
  let noticeRequests = 0;
  await page.route(`${API}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me') {
      await familyReady;
      return route.fulfill({ json: registered });
    }
    if (path === '/v1/notifications') noticeRequests++;
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/');
  try {
    await expect(page.getByTestId('guardian-family-loading')).toBeVisible();
    await expect(appAlerts(page)).toHaveCount(0);
    expect(noticeRequests).toBe(0);
  } finally {
    releaseFamily();
  }
  await expect(page.getByTestId('guardian-no-children')).toBeVisible();
  await expect(page.getByTestId('notifications-empty')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(noticeRequests).toBeGreaterThan(0);
});

test('unauthenticated guardian is redirected to registration', async ({ page }) => {
  await page.route(`${API}/**`, (route) =>
    route.fulfill({
      status: 401,
      json: { error: { code: 'UNAUTHENTICATED', message: 'ログインしてください' } },
    }),
  );
  await page.goto('/');
  await expect(page).toHaveURL(/\/signup$/);
  await expect(appAlerts(page)).toHaveCount(0);
});

for (const path of [
  '/signup?invite=tok_ABCDEFGHIJKLMNOPQRS',
  '/invite/tok_ABCDEFGHIJKLMNOPQRS',
  '/offline',
]) {
  test(`unregistered guardian can still open ${path}`, async ({ page }) => {
    await page.route(`${API}/**`, (route) => route.fulfill(missingFamily));
    const response = page.waitForResponse(`${API}/v1/me`);
    await page.goto(path);
    await response;
    const heading = path.startsWith('/signup')
      ? '保護者の登録'
      : path.startsWith('/invite')
        ? '保護者への招待'
        : 'インターネットに接続されていません';
    await expect(page.getByText(heading, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(new URL(path, test.info().project.use.baseURL).toString());
    await expect(appAlerts(page)).toHaveCount(0);
  });
}

for (const status of [403, 500]) {
  test(`${status} family failure remains retryable instead of redirecting`, async ({ page }) => {
    let recovered = false;
    await page.route(`${API}/**`, (route) => {
      if (new URL(route.request().url()).pathname === '/v1/me')
        return route.fulfill(
          recovered
            ? { json: registered }
            : {
                status,
                json: {
                  error: {
                    code: status === 403 ? 'PERMISSION_DENIED' : 'INTERNAL',
                    message: '確認できませんでした',
                  },
                },
              },
        );
      return route.fulfill({ json: { items: [] } });
    });
    await page.goto('/');
    await expect(page.getByTestId('guardian-error')).toHaveCount(1);
    await expect(page).toHaveURL(/\/$/);
    recovered = true;
    await page.getByTestId('guardian-error').getByRole('button', { name: '再試行' }).click();
    await expect(page.getByTestId('guardian-no-children')).toBeVisible();
    await expect(page.getByTestId('notifications-empty')).toBeVisible();
    await expect(appAlerts(page)).toHaveCount(0);
  });
}

test('registration continues to consent without another redirect', async ({ page }) => {
  let created = false;
  let noticeRequests = 0;
  await page.route(`${API}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/families' && route.request().method() === 'POST') {
      created = true;
      return route.fulfill({ status: 201, json: { familyId: registered.family.familyId } });
    }
    if (path === '/v1/me')
      return route.fulfill(
        created
          ? { json: { ...registered, family: { ...registered.family, consentComplete: false } } }
          : missingFamily,
      );
    if (path === '/v1/notifications') noticeRequests++;
    return route.fulfill({ json: { items: [] } });
  });
  await page.goto('/');
  await expect(page).toHaveURL(/\/signup$/);
  await expect(
    page.getByRole('button', { name: /ローカル家族を登録|登録して続ける/ }),
  ).toBeVisible();
  // The e2e server runs `next start` on the regular build; only a NEXT_PUBLIC_LOCAL_DEMO=1 build
  // registers without Firebase Auth, which this mocked flow cannot provide.
  test.skip(
    (await page.getByRole('button', { name: 'ローカル家族を登録' }).count()) === 0,
    'needs a guardian build with NEXT_PUBLIC_LOCAL_DEMO=1',
  );
  await page.getByLabel('表示名（任意）').fill('合成登録テスト');
  await page.getByRole('button', { name: 'ローカル家族を登録' }).click();
  await expect(page).toHaveURL(/\/consent$/);
  await expect(appAlerts(page)).toHaveCount(0);
  expect(created).toBe(true);
  expect(noticeRequests).toBe(0);
});
