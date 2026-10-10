import type { MeRes } from '@ijime/api-types';
import { expect, test, type Page } from '@playwright/test';

const API = 'http://localhost:8080';

function me(role: MeRes['guardian']['role']): MeRes {
  return {
    guardian: { guardianId: 'g1', role, email: 'parent@example.com' },
    family: { familyId: 'f1', termsVersion: 'v1', consentComplete: true },
    children: [],
  };
}

function apiError(status: number, code: string, message: string) {
  return { status, json: { error: { code, message, requestId: 'r1' } } };
}

async function mockApi(
  page: Page,
  role: MeRes['guardian']['role'],
  extra: Record<string, { status: number; json: unknown }> = {},
) {
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const hit = extra[`${req.method()} ${path}`];
    if (hit) return route.fulfill(hit);
    if (path === '/v1/me') return route.fulfill({ json: me(role) });
    if (path === '/v1/guardians/me/notify-settings')
      return route.fulfill({ json: { channels: ['email'] } });
    if (path === '/v1/notifications') return route.fulfill({ json: { items: [] } });
    return route.fulfill(apiError(404, 'NOT_FOUND', 'not mocked'));
  });
}

test.describe('settings: push and second guardian', () => {
  test('primary creates an invitation link; push falls back to email when FCM is not configured', async ({
    page,
  }) => {
    await mockApi(page, 'primary', {
      'POST /v1/guardians/invitations': {
        status: 201,
        json: { invitationId: 'tok_ABCDEFGHIJKLMNOPQRS', expiresAt: '2026-10-08T00:00:00.000Z' },
      },
    });
    await page.goto('/settings');
    await expect(page.getByTestId('push-unconfigured')).toBeVisible();
    await page.getByTestId('invite-email').fill('second@example.com');
    await page.getByTestId('invite-submit').click();
    await expect(page.getByTestId('invite-link')).toHaveValue(/\/invite\/tok_ABCDEFGHIJKLMNOPQRS$/);
  });

  test('an existing second guardian is reported', async ({ page }) => {
    await mockApi(page, 'primary', {
      'POST /v1/guardians/invitations': apiError(
        409,
        'ALREADY_EXISTS',
        'すでに第二保護者が登録されています',
      ),
    });
    await page.goto('/settings');
    await page.getByTestId('invite-email').fill('second@example.com');
    await page.getByTestId('invite-submit').click();
    await expect(page.getByTestId('invite-error')).toHaveText(
      'すでに第二保護者が登録されています。',
    );
  });

  test('a secondary guardian cannot invite', async ({ page }) => {
    await mockApi(page, 'secondary');
    await page.goto('/settings');
    await expect(page.getByTestId('secondary-note')).toBeVisible();
    await expect(page.getByTestId('invite-email')).toHaveCount(0);
  });
});

test.describe('iPhone Safari outside the home screen', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  test('shows the add-to-home-screen guidance', async ({ page }) => {
    await mockApi(page, 'primary');
    await page.goto('/settings');
    await expect(page.getByTestId('install-prompt')).toBeVisible();
    await page.goto('/');
    await expect(page.getByTestId('install-prompt')).toBeVisible();
  });
});

test.describe('accepting an invitation', () => {
  const ACCEPT = 'POST /v1/guardians/invitations/tok_ABCDEFGHIJKLMNOPQRS/accept';

  test('expired invitations ask the primary guardian to re-invite', async ({ page }) => {
    await mockApi(page, 'secondary', {
      [ACCEPT]: apiError(410, 'INVITATION_EXPIRED', '招待の期限が切れています'),
    });
    await page.goto('/invite/tok_ABCDEFGHIJKLMNOPQRS');
    await page.getByTestId('invite-accept-submit').click();
    await expect(page.getByTestId('invite-accept-error')).toContainText(
      '主保護者にもう一度招待してもらってください',
    );
  });

  test('a different email is told to sign in with the invited address', async ({ page }) => {
    await mockApi(page, 'secondary', {
      [ACCEPT]: apiError(403, 'PERMISSION_DENIED', 'このメールアドレス宛ての招待ではありません'),
    });
    await page.goto('/invite/tok_ABCDEFGHIJKLMNOPQRS');
    await page.getByTestId('invite-accept-submit').click();
    const error = page.getByTestId('invite-accept-error');
    await expect(error).toContainText('このメールアドレス宛ての招待ではありません');
    await expect(error.getByRole('link')).toHaveAttribute(
      'href',
      '/signup?invite=tok_ABCDEFGHIJKLMNOPQRS',
    );
  });

  test('success continues to settings', async ({ page }) => {
    await mockApi(page, 'secondary', { [ACCEPT]: { status: 200, json: { familyId: 'f1' } } });
    await page.goto('/invite/tok_ABCDEFGHIJKLMNOPQRS');
    await page.getByTestId('invite-accept-submit').click();
    await expect(page).toHaveURL(/\/settings$/);
  });
});
