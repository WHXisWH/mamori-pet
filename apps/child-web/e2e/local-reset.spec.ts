import { expect, test, type Page } from '@playwright/test';

const guardianUrl = process.env['PW_GUARDIAN_URL'] ?? 'http://localhost:3101';

test.use({ serviceWorkers: 'block' });

test.beforeEach(async ({ context }) => {
  await context.route('**/v1/**', async (route) => {
    const request = route.request();
    const headers = {
      'access-control-allow-origin': request.headers()['origin'] ?? '*',
      'access-control-allow-headers':
        'Content-Type, X-Dev-Child-Id, X-Dev-Guardian-Id, Authorization',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (new URL(request.url()).pathname === '/v1/notifications') {
      return route.fulfill({ headers, json: { items: [] } });
    }
    return route.fulfill({
      status: 401,
      headers,
      json: { error: { code: 'UNAUTHENTICATED', message: 'Local reset test fixture' } },
    });
  });
});

async function seedOldState(page: Page, origin: string) {
  await page.goto(`${origin}/offline`);
  await page.evaluate(() => {
    localStorage.setItem(
      'mamori-child',
      JSON.stringify({
        state: {
          paired: true,
          childId: 'c_old_reset',
          assented: true,
          characterId: 'moko',
          gradeBand: 'high',
          petName: 'Old pet',
        },
        version: 0,
      }),
    );
    localStorage.setItem('mamori-guardian-id', 'g_old_reset');
    localStorage.setItem('mamori-old-draft', 'old draft');
    localStorage.setItem('foreign-key', 'keep local');
    sessionStorage.setItem('mamori-old-session', 'old session');
    sessionStorage.setItem('foreign-key', 'keep session');
  });
}

async function expectResetStorage(page: Page) {
  const state = await page.evaluate(() => ({
    child: JSON.parse(localStorage.getItem('mamori-child') ?? 'null') as {
      state: { paired: boolean; childId: string; assented: boolean; characterId: string | null };
    } | null,
    guardian: localStorage.getItem('mamori-guardian-id'),
    draft: localStorage.getItem('mamori-old-draft'),
    session: sessionStorage.getItem('mamori-old-session'),
    foreignLocal: localStorage.getItem('foreign-key'),
    foreignSession: sessionStorage.getItem('foreign-key'),
  }));
  // Zustand can persist its empty defaults again after the clean document loads.
  if (state.child)
    expect(state.child.state).toMatchObject({
      paired: false,
      childId: '',
      assented: false,
      characterId: null,
    });
  expect(state).toMatchObject({
    guardian: null,
    draft: null,
    session: null,
    foreignLocal: 'keep local',
    foreignSession: 'keep session',
  });
}

test('child reset discards old pairing before hydration and repeated reset stays at /pair', async ({
  page,
}) => {
  await seedOldState(page, '');
  const homeRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/child/home') homeRequests.push(request.url());
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto('/pair?resetLocal=1');
    await expect(page).toHaveURL(/\/pair$/);
    await expect(page.getByTestId('pair-code')).toBeVisible();
    await expect(page.getByTestId('pet-room')).toHaveCount(0);
    await expectResetStorage(page);
  }
  expect(homeRequests).toEqual([]);
});

test('guardian reset discards old identity and repeated reset stays at /signup', async ({
  page,
}) => {
  await seedOldState(page, guardianUrl);
  const oldIdentityRequests: string[] = [];
  page.on('request', (request) => {
    if (request.headers()['x-dev-guardian-id'] === 'g_old_reset')
      oldIdentityRequests.push(request.url());
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(`${guardianUrl}/signup?resetLocal=1`);
    await expect(page).toHaveURL(`${guardianUrl}/signup`);
    await expect(page.getByRole('heading', { name: '保護者の登録' })).toBeVisible();
    await expectResetStorage(page);
  }
  expect(oldIdentityRequests).toEqual([]);
});

test('plain child and guardian paths preserve local preview state', async ({ page }) => {
  for (const origin of ['', guardianUrl]) {
    await seedOldState(page, origin);
    await page.goto(`${origin}/offline`);
    const state = await page.evaluate(() => ({
      guardian: localStorage.getItem('mamori-guardian-id'),
      draft: localStorage.getItem('mamori-old-draft'),
      session: sessionStorage.getItem('mamori-old-session'),
      childId: JSON.parse(localStorage.getItem('mamori-child')!).state.childId,
    }));
    expect(state).toEqual({
      guardian: 'g_old_reset',
      draft: 'old draft',
      session: 'old session',
      childId: 'c_old_reset',
    });
    await expect(page).toHaveURL(/\/offline$/);
  }
});
