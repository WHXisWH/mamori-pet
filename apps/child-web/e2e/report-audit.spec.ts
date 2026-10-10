import { randomUUID } from 'node:crypto';

import type {
  ArtworkRes,
  CreateChildRes,
  DataSourcesBody,
  ErrorCode,
  MeRes,
  MemoryProposalsRes,
  MessagesRes,
  NotificationDetail,
  PairingCodeRes,
  StartSessionRes,
} from '@ijime/api-types';
import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Response,
} from '@playwright/test';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8680';
const GUARDIAN = process.env['PW_GUARDIAN_URL'] ?? 'http://localhost:3701';
const sources: DataSourcesBody['dataSources'] = {
  voice: true,
  typing: true,
  artwork_save: true,
  home_checkin: true,
  calendar: false,
};

test.beforeAll(() => {
  for (const url of [API, GUARDIAN]) {
    expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(url).hostname);
  }
});

async function body<T>(response: APIResponse | Response, status = 200): Promise<T> {
  expect(response.status(), response.url()).toBe(status);
  return (await response.json()) as T;
}

async function denied(response: APIResponse, status: number, code: ErrorCode) {
  expect(await body(response, status)).toMatchObject({ error: { code } });
}

async function family(request: APIRequestContext) {
  const guardianId = `g_audit_${randomUUID()}`;
  const guardianHeaders = { 'X-Dev-Guardian-Id': guardianId };
  await body(
    await request.post(`${API}/v1/families`, {
      headers: guardianHeaders,
      data: { displayName: '合成監査用保護者' },
    }),
    201,
  );
  for (const type of ['guardian_terms', 'guardian_sensitive']) {
    await body(
      await request.post(`${API}/v1/consents`, {
        headers: guardianHeaders,
        data: { type, documentVersion: 'v0.1' },
      }),
      201,
    );
  }
  const { childId } = await body<CreateChildRes>(
    await request.post(`${API}/v1/children`, {
      headers: guardianHeaders,
      data: { nickname: '監査そら', gradeBand: 'high' },
    }),
    201,
  );
  return { guardianId, guardianHeaders, childId, childHeaders: { 'X-Dev-Child-Id': childId } };
}

type Family = Awaited<ReturnType<typeof family>>;

async function activate(request: APIRequestContext, account: Family) {
  await body(
    await request.post(`${API}/v1/child/assent`, {
      headers: account.childHeaders,
      data: { documentVersion: 'v0.1', dataSources: sources },
    }),
    201,
  );
  await body(
    await request.post(`${API}/v1/child/pets`, {
      headers: account.childHeaders,
      data: { characterId: 'moko', petName: '' },
    }),
    201,
  );
}

async function childPage(page: Page, account: Family) {
  await activate(page.request, account);
  await page.goto('/pair');
  // Local identity setup only; consent, preferences and all audited actions use the real API.
  await page.evaluate(
    ({ childId, sources }) =>
      localStorage.setItem(
        'mamori-child',
        JSON.stringify({
          state: {
            paired: true,
            assented: true,
            childId,
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
    { childId: account.childId, sources },
  );
}

async function pairingCode(request: APIRequestContext, account: Family) {
  const result = await body<PairingCodeRes>(
    await request.post(`${API}/v1/children/${account.childId}/pairing-codes`, {
      headers: account.guardianHeaders,
    }),
    201,
  );
  expect(result.code).toMatch(/^\d{6}$/);
  expect(result.code).not.toBe('123456');
  return result.code;
}

async function pairInUi(page: Page, code: string) {
  await page.getByTestId('pair-code').fill(code);
  const response = page.waitForResponse(
    (res) => res.url() === `${API}/v1/child/pair` && res.request().method() === 'POST',
  );
  await page.getByTestId('pair-submit').click();
  return response;
}

for (const grade of ['low', 'high', 'jhs'] as const) {
  test(`UI regression: ${grade} chat keeps navigation, local notice and composer separate`, async ({
    page,
    request,
  }) => {
    const account = await family(request);
    await childPage(page, account);
    await page.evaluate((gradeBand) => {
      const stored = JSON.parse(localStorage.getItem('mamori-child')!);
      stored.state.gradeBand = gradeBand;
      localStorage.setItem('mamori-child', JSON.stringify(stored));
    }, grade);
    await page.goto('/chat');
    await expect(page.getByTestId('chat-input')).toBeEnabled();

    const layout = async () => {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const rect = (selector: string) =>
              document.querySelector(selector)!.getBoundingClientRect();
            const help = rect('[data-testid="help-button"]');
            const note = rect('[data-testid="local-test-mode"]');
            const panel = rect('[data-testid="chat-panel"]');
            // The visible message area is the chat-scroll viewport; role="log" is its scrolling content.
            const log = rect('[data-testid="chat-scroll"]');
            const input = rect('[data-testid="chat-input"]');
            const send = rect('[data-testid="chat-send"]');
            const notice = document.querySelector('[data-testid="local-test-mode"]')!;
            return {
              noteBelowNavigation: note.top >= help.bottom - 1,
              panelBelowNote: panel.top >= note.bottom - 1,
              composerBelowLog: input.top >= log.bottom - 1,
              composerInViewport: Math.max(input.bottom, send.bottom) <= innerHeight + 1,
              panelInViewport: panel.bottom <= innerHeight + 1,
              logHasSpace: log.height >= 48,
              noDocumentOverflow:
                document.documentElement.scrollHeight <= innerHeight + 1 &&
                document.documentElement.scrollWidth <= innerWidth + 1,
              noticeUncovered: notice.contains(
                document.elementFromPoint(note.x + note.width / 2, note.y + note.height / 2),
              ),
            };
          }),
        )
        .toEqual({
          noteBelowNavigation: true,
          panelBelowNote: true,
          composerBelowLog: true,
          composerInViewport: true,
          panelInViewport: true,
          logHasSpace: true,
          noDocumentOverflow: true,
          noticeUncovered: true,
        });
    };

    await layout();
    await page.getByTestId('chat-input').fill('ねこが すきなこと、おぼえてて');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('memory-proposal')).toHaveAttribute('data-status', 'pending');
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
    await page.getByTestId('chat-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await layout();
    await page.getByTestId('voice-toggle').click();
    await expect(page.getByTestId('voice-error')).toBeVisible();
    await layout();
    await page.setViewportSize({ width: 320, height: 568 });
    await layout();
    await page.getByTestId('chat-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await layout();
    await page.getByTestId('chat-input').fill('こんにちは');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('msg-pet')).toHaveCount(3);
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
    await layout();
  });
}

test('UI regression: guardian notification hides empty sections and retains populated guidance', async ({
  page,
  request,
}) => {
  const account = await family(request);
  await childPage(page, account);
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await page.getByTestId('chat-input').fill('もう死にたい');
  await page.getByTestId('chat-send').click();
  await expect(page).toHaveURL(/\/safe$/);
  let id = '';
  await expect
    .poll(async () => {
      const { items } = await body<{ items: { id: string; kind: string }[] }>(
        await request.get(`${API}/v1/notifications`, { headers: account.guardianHeaders }),
      );
      id = items.find((item) => item.kind === 'crisis')?.id ?? '';
      return id;
    })
    .not.toBe('');
  const url = `${API}/v1/notifications/${id}`;
  const notice = await body<NotificationDetail>(
    await request.get(url, { headers: account.guardianHeaders }),
  );
  expect(notice.changes).toEqual([]);
  expect(notice.suggestions.avoid).toEqual([]);
  await page.addInitScript(
    (id) => localStorage.setItem('mamori-guardian-id', id),
    account.guardianId,
  );
  await page.goto(`${GUARDIAN}/notifications/${id}`);
  const detail = page.getByTestId('notification-detail');
  await expect(detail).toBeVisible();
  for (const name of ['最近の変化', '避けたいこと'])
    await expect(detail.getByRole('heading', { name, exact: true })).toHaveCount(0);
  for (const name of ['考えられること', 'できること', '相談先'])
    await expect(detail.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(page.getByTestId('notification-ack')).toBeVisible();

  // Presentation-only fixtures cover optional sections without inventing stored child facts.
  let variant: NotificationDetail = {
    ...notice,
    changes: [' '],
    meaning: ' ',
    childSummary: ' ',
    suggestions: { try: [' '], avoid: [' '] },
    resources: [],
  };
  await page.route(url, (route) => route.fulfill({ json: variant }));
  await page.reload();
  await expect(detail).toBeVisible();
  // その後の対応 is the guardian's own follow-up form, not one of the notification's sections.
  const sectionHeadings = detail.locator('h3').filter({ hasNotText: 'その後の対応' });
  await expect(sectionHeadings).toHaveCount(0);
  await expect(detail.getByRole('heading', { name: notice.title, exact: true })).toBeVisible();
  await expect(page.getByTestId('notification-ack')).toBeVisible();
  variant = {
    ...notice,
    changes: ['合成表示テストの変化'],
    childSummary: '共有を選んだ合成要約',
    suggestions: { try: ['合成表示テストの提案'], avoid: ['合成表示テストの注意'] },
  };
  await page.reload();
  await expect(sectionHeadings).toHaveCount(6);
  await expect(detail).toContainText(variant.changes[0]!);
  await expect(detail).toContainText(variant.suggestions.try[0]!);
  await expect(detail).toContainText(variant.suggestions.avoid[0]!);
  await expect(page.getByTestId('child-approved-summary')).toContainText(variant.childSummary!);
  await expect(detail.locator('a[href^="tel:"]').first()).toBeVisible();
});

test('UI audit: malformed pairing input stays unpaired and the API rejects invalid codes', async ({
  page,
  request,
}) => {
  await page.goto('/pair');
  await expect(page.getByTestId('pair-submit')).toBeDisabled();
  await page.getByTestId('pair-code').fill('12ab45');
  await expect(page.getByTestId('pair-code')).toHaveValue('1245');
  await expect(page.getByTestId('pair-submit')).toBeDisabled();
  await page.getByTestId('pair-code').fill('12345');
  await expect(page.getByTestId('pair-submit')).toBeDisabled();
  await denied(
    await request.post(`${API}/v1/child/pair`, { data: { code: '12ab45' } }),
    400,
    'INVALID_ARGUMENT',
  );
  await expect(page).toHaveURL(/\/pair$/);
  await expect(page.getByTestId('assent')).toHaveCount(0);
});

test('UI audit: a replacement pairing code invalidates the older code and pairs the intended child', async ({
  page,
  request,
}) => {
  const account = await family(request);
  const oldCode = await pairingCode(request, account);
  const newestCode = await pairingCode(request, account);
  expect(newestCode).not.toBe(oldCode);
  await page.goto('/pair');
  expect((await pairInUi(page, oldCode)).status()).toBe(410);
  await expect(page.getByTestId('pair-error')).toBeVisible();
  // The UI discards error bodies; inspect the error contract through APIRequestContext.
  await denied(
    await request.post(`${API}/v1/child/pair`, { data: { code: oldCode } }),
    410,
    'PAIRING_CODE_EXPIRED',
  );
  await expect(page).toHaveURL(/\/pair$/);
  const before = await body<MeRes>(
    await request.get(`${API}/v1/me`, { headers: account.guardianHeaders }),
  );
  expect(before.children).toContainEqual(
    expect.objectContaining({ childId: account.childId, paired: false }),
  );
  expect(await body(await pairInUi(page, newestCode))).toMatchObject({
    childId: account.childId,
    needsAssent: true,
  });
  await expect(page.getByTestId('assent')).toBeVisible();
  await denied(
    await request.get(`${API}/v1/child/home`, { headers: account.childHeaders }),
    403,
    'ASSENT_REQUIRED',
  );
});

test('UI audit: a consumed pairing code cannot pair another browser session', async ({
  page,
  request,
}) => {
  const account = await family(request);
  const code = await pairingCode(request, account);
  expect(await body(await request.post(`${API}/v1/child/pair`, { data: { code } }))).toMatchObject({
    childId: account.childId,
  });
  await page.goto('/pair');
  expect((await pairInUi(page, code)).status()).toBe(410);
  await expect(page.getByTestId('pair-error')).toBeVisible();
  await denied(
    await request.post(`${API}/v1/child/pair`, { data: { code } }),
    410,
    'PAIRING_CODE_EXPIRED',
  );
  await page.reload();
  await expect(page.getByTestId('pairing')).toBeVisible();
  await expect(page.getByTestId('assent')).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('mamori-child')!).state.paired),
  ).toBe(false);
});

test('UI audit: guardian consent withdrawal blocks an existing chat and new child activity', async ({
  page,
  context,
  request,
}) => {
  const account = await family(request);
  await childPage(page, account);
  const started = page.waitForResponse(
    (res) => res.url() === `${API}/v1/child/chat/sessions` && res.request().method() === 'POST',
  );
  await page.goto('/chat');
  const { sessionId } = await body<StartSessionRes>(await started, 201);
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  const guardian = await context.newPage();
  await guardian.addInitScript(
    (id) => localStorage.setItem('mamori-guardian-id', id),
    account.guardianId,
  );
  await guardian.goto(`${GUARDIAN}/consent`);
  const record = guardian.getByRole('listitem').filter({ hasText: '利用条件' });
  await record.getByRole('button', { name: '撤回する', exact: true }).click();
  const withdrawn = guardian.waitForResponse(
    (res) => res.url().startsWith(`${API}/v1/consents/`) && res.request().method() === 'DELETE',
  );
  await guardian.getByRole('button', { name: '撤回して利用を停止', exact: true }).click();
  expect((await withdrawn).status()).toBe(204);
  await expect(guardian.getByRole('dialog')).toHaveCount(0);
  await expect(record).toContainText('撤回済み');
  const me = await body<MeRes>(
    await request.get(`${API}/v1/me`, { headers: account.guardianHeaders }),
  );
  expect(me.family.consentComplete).toBe(false);
  const blocked = page.waitForResponse(
    (res) => res.url() === `${API}/v1/child/chat/sessions/${sessionId}/messages`,
  );
  await page.getByTestId('chat-input').fill('こんにちは');
  await page.getByTestId('chat-send').click();
  expect((await blocked).status()).toBe(404);
  await expect(page.getByTestId('chat-panel').getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('msg-pet')).toHaveCount(1);
  for (const [path, data] of [
    ['/v1/child/chat/sessions', {}],
    ['/v1/child/mood', { weather: 'sunny' }],
    ['/v1/child/home-checkins', { atHome: true, method: 'manual' }],
  ] as const) {
    await denied(
      await request.post(`${API}${path}`, { headers: account.childHeaders, data }),
      404,
      'NOT_FOUND',
    );
  }
  await page.goto('/help');
  await expect(page.getByTestId('hotline-call').first()).toBeVisible();
  await guardian.close();
});

test('UI audit: declining a scripted memory proposal keeps it absent after reload and rejects late acceptance', async ({
  page,
  request,
}) => {
  const account = await family(request);
  await childPage(page, account);
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await page.getByTestId('chat-input').fill('ねこが すきなこと、おぼえてて');
  await page.getByTestId('chat-send').click();
  const card = page.getByTestId('memory-proposal');
  await expect(card).toHaveAttribute('data-status', 'pending');
  const pending = await body<MemoryProposalsRes>(
    await request.get(`${API}/v1/child/memory-proposals`, { headers: account.childHeaders }),
  );
  expect(pending.items).toHaveLength(1);
  const decisionUrl = `${API}/v1/child/memory-proposals/${pending.items[0]!.proposalId}/decision`;
  const rejected = page.waitForResponse(
    (res) => res.url() === decisionUrl && res.request().method() === 'POST',
  );
  await card.getByTestId('memory-reject').click();
  expect(await body(await rejected)).toEqual({ status: 'rejected' });
  await expect(card).toHaveAttribute('data-status', 'rejected');
  await denied(
    await request.post(decisionUrl, {
      headers: account.childHeaders,
      data: { decision: 'accept' },
    }),
    409,
    'ALREADY_EXISTS',
  );
  await page.goto('/settings');
  await page.reload();
  await expect(page.getByTestId('source-voice')).toBeEnabled();
  await expect(page.getByRole('button', { name: /を消す/ })).toHaveCount(0);
  for (const path of ['memories', 'memory-proposals']) {
    expect(
      await body(await request.get(`${API}/v1/child/${path}`, { headers: account.childHeaders })),
    ).toEqual({ items: [] });
  }
  expect(await page.evaluate(() => localStorage.getItem('mamori-child'))).not.toContain('ねこが');
});

test('UI audit: simulated geolocation denial falls back to a manual check-in without coordinates', async ({
  page,
  request,
}) => {
  const account = await family(request);
  // Explicit browser-permission fixture; the check-in itself uses the real local API.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(_success: PositionCallback, error?: PositionErrorCallback) {
          const key = 'report-audit-geo-denials';
          sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? 0) + 1));
          error?.({
            code: 1,
            message: 'Synthetic permission denied',
            PERMISSION_DENIED: 1,
            POSITION_UNAVAILABLE: 2,
            TIMEOUT: 3,
          });
        },
      },
    });
  });
  await childPage(page, account);
  await page.goto('/settings');
  await page.getByTestId('home-location-save').click();
  await expect(
    page.getByRole('alert').filter({ hasText: '手動の「ただいま」も使えます' }),
  ).toBeVisible();
  await expect(page.getByTestId('home-location-status')).toHaveText('まだ設定していません');
  expect(
    await page.evaluate(
      (id) => localStorage.getItem(`mamori-home-geofence:${id}`),
      account.childId,
    ),
  ).toBeNull();
  // A previously saved synthetic fence exercises denial during check-in, not only a missing fence.
  await page.evaluate(
    (id) =>
      localStorage.setItem(
        `mamori-home-geofence:${id}`,
        JSON.stringify({
          lat: 35.123456,
          lng: 139.123456,
          radiusM: 200,
        }),
      ),
    account.childId,
  );
  const checkins: unknown[] = [];
  page.on('request', (req) => {
    if (req.url() === `${API}/v1/child/home-checkins` && req.method() === 'POST')
      checkins.push(req.postDataJSON());
  });
  await page.goto('/?checkin=1');
  const manual = page.getByTestId('home-checkin').getByRole('button');
  await expect(manual).toBeVisible();
  expect(checkins).toEqual([]);
  expect(
    await page.evaluate(() => Number(sessionStorage.getItem('report-audit-geo-denials'))),
  ).toBeGreaterThanOrEqual(2);
  const checkedIn = page.waitForResponse(
    (res) => res.url() === `${API}/v1/child/home-checkins` && res.request().method() === 'POST',
  );
  await manual.click();
  expect((await checkedIn).status()).toBe(201);
  expect(checkins).toEqual([{ atHome: true, method: 'manual' }]);
  await expect(page.getByTestId('home-checkin')).toHaveCount(0);
});

test('UI audit: disabling voice hides its control after reload and the API refuses voice tickets', async ({
  page,
  request,
}) => {
  const account = await family(request);
  await childPage(page, account);
  await page.goto('/settings');
  await expect(page.getByTestId('source-voice')).toBeEnabled();
  await expect(page.getByTestId('source-voice')).toBeChecked();
  const saved = page.waitForResponse(
    (res) => res.url() === `${API}/v1/child/data-sources` && res.request().method() === 'PUT',
  );
  await page.getByTestId('source-voice').click();
  expect(await body(await saved)).toMatchObject({ dataSources: { voice: false } });
  await expect(page.getByTestId('source-voice')).not.toBeChecked();
  await page.reload();
  await expect(page.getByTestId('source-voice')).toBeEnabled();
  await expect(page.getByTestId('source-voice')).not.toBeChecked();
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await expect(page.getByTestId('voice-toggle')).toHaveCount(0);
  await denied(
    await request.post(`${API}/v1/child/voice/tickets`, { headers: account.childHeaders }),
    403,
    'DATA_SOURCE_DISABLED',
  );
  await page.getByTestId('chat-input').fill('こんにちは');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('msg-pet')).toHaveCount(2);
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await expect(page.getByTestId('chat-panel').getByRole('alert')).toHaveCount(0);
});

test('UI audit: an explicitly unsaved drawing has no share control and cannot enter the guardian gallery', async ({
  page,
  request,
}) => {
  const account = await family(request);
  await childPage(page, account);
  await page.goto('/draw/story');
  await expect(page.getByTestId('story-prompt')).toBeVisible();
  await expect(page.getByTestId('artwork-save')).not.toBeChecked();
  const canvas = await page.locator('canvas').boundingBox();
  expect(canvas).not.toBeNull();
  await page.mouse.move(canvas!.x + 20, canvas!.y + 20);
  await page.mouse.down();
  await page.mouse.move(canvas!.x + 90, canvas!.y + 70, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId('draw-done').click();
  await page.getByTestId('narrative-input').fill('あおい そらを かいたよ');
  const submitted = page.waitForResponse(
    (res) => res.url() === `${API}/v1/child/artworks` && res.request().method() === 'POST',
  );
  await page.getByTestId('narrative-done').click();
  const response = await submitted;
  const { artworkId } = await body<ArtworkRes>(response, 201);
  expect(response.request().headers()['content-type']).toContain('multipart/form-data');
  await expect(page.getByTestId('draw-page')).toHaveAttribute('data-step', 'done');
  await expect(page.getByTestId('artwork-share')).toHaveCount(0);
  await denied(
    await request.post(`${API}/v1/child/artworks/${artworkId}/share`, {
      headers: account.childHeaders,
    }),
    400,
    'INVALID_ARGUMENT',
  );
  expect(
    await body(
      await request.get(`${API}/v1/children/${account.childId}/shared-artworks`, {
        headers: account.guardianHeaders,
      }),
    ),
  ).toEqual({ items: [] });
});

test('API audit: another family cannot issue pairing codes or read a child report or gallery', async ({
  request,
}) => {
  const owner = await family(request);
  const other = await family(request);
  for (const endpoint of ['weekly-reports', 'shared-artworks']) {
    const url = `${API}/v1/children/${owner.childId}/${endpoint}`;
    const own = await request.get(url, { headers: owner.guardianHeaders });
    if (endpoint === 'weekly-reports') {
      // Fresh families have no fabricated weekly report.
      expect(await body(own, 404)).toMatchObject({
        error: { code: 'NOT_FOUND', message: 'この週の記録はまだありません' },
      });
    } else expect(await body(own)).toEqual({ items: [] });
    await denied(await request.get(url, { headers: other.guardianHeaders }), 404, 'NOT_FOUND');
  }
  const code = await pairingCode(request, owner);
  await denied(
    await request.post(`${API}/v1/children/${owner.childId}/pairing-codes`, {
      headers: other.guardianHeaders,
    }),
    404,
    'NOT_FOUND',
  );
  expect(await body(await request.post(`${API}/v1/child/pair`, { data: { code } }))).toMatchObject({
    childId: owner.childId,
  });
  const me = await body<MeRes>(
    await request.get(`${API}/v1/me`, { headers: other.guardianHeaders }),
  );
  expect(me.children.map((child) => child.childId)).toEqual([other.childId]);
});

test('API audit: a child cannot read or append to another child chat session', async ({
  request,
}) => {
  const owner = await family(request);
  const other = await family(request);
  await activate(request, owner);
  await activate(request, other);
  const { sessionId } = await body<StartSessionRes>(
    await request.post(`${API}/v1/child/chat/sessions`, { headers: owner.childHeaders, data: {} }),
    201,
  );
  const url = `${API}/v1/child/chat/sessions/${sessionId}/messages`;
  const message = {
    text: 'こんにちは',
    inputMode: 'typed',
    clientSentAt: new Date().toISOString(),
  };
  const sent = await request.post(url, { headers: owner.childHeaders, data: message });
  expect(sent.status()).toBe(200);
  expect(await sent.text()).toContain('event: done');
  const before = await body<MessagesRes>(await request.get(url, { headers: owner.childHeaders }));
  expect(before.items).toContainEqual(
    expect.objectContaining({ role: 'child', text: message.text }),
  );
  await denied(await request.get(url, { headers: other.childHeaders }), 404, 'NOT_FOUND');
  await denied(
    await request.post(url, { headers: other.childHeaders, data: message }),
    404,
    'NOT_FOUND',
  );
  expect(await body(await request.get(url, { headers: owner.childHeaders }))).toEqual(before);
  expect(
    await body(await request.get(`${API}/v1/child/chat/sessions`, { headers: other.childHeaders })),
  ).toEqual({ items: [] });
});

test('API audit: protected endpoints reject missing or wrong-role identities while help remains public', async ({
  request,
}) => {
  const account = await family(request);
  for (const path of [
    '/v1/me',
    '/v1/consents',
    '/v1/notifications',
    '/v1/child/home',
    '/v1/child/memories',
    '/v1/child/chat/sessions',
    `/v1/children/${account.childId}/shared-artworks`,
  ]) {
    await denied(await request.get(`${API}${path}`), 401, 'UNAUTHENTICATED');
  }
  for (const path of [
    '/v1/child/chat/sessions',
    '/v1/child/voice/tickets',
    `/v1/children/${account.childId}/pairing-codes`,
  ]) {
    await denied(await request.post(`${API}${path}`, { data: {} }), 401, 'UNAUTHENTICATED');
  }
  await denied(
    await request.get(`${API}/v1/child/home`, { headers: account.guardianHeaders }),
    401,
    'UNAUTHENTICATED',
  );
  await denied(
    await request.get(`${API}/v1/me`, { headers: account.childHeaders }),
    401,
    'UNAUTHENTICATED',
  );
  expect((await request.get(`${API}/v1/child/help-resources`)).status()).toBe(200);
});
