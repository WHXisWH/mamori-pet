import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ChatSafetyRes,
  CrisisPayload,
  MessagesRes,
  PetAction,
  SseEvent,
} from '@ijime/api-types';
import { expect, test as base, type Page } from '@playwright/test';
import { seedChild } from './fixtures/requests';

const SESSION = 'fault_session';
const MESSAGE = 'fault_saved_message';
const SESSION_PATH = `/v1/child/chat/sessions/${SESSION}`;
const INPUT = '先生に相談してみたいけれど、どう話せばいいかわからない。';
const FALLBACK = 'いまは おへんじを つくれなかったよ。おはなしは とどいているよ。';
const RECOVERED = '先生に「少しお話してもいいですか」と言う練習をしてみよう。';
const OFFER: PetAction = {
  type: 'offer_tell_adult',
  consultationId: 'fault_existing_consultation',
  openingLine: '先生、少し相談してもいいですか。',
};
const PENDING: Extract<ChatSafetyRes, { status: 'pending_review' }> = {
  status: 'pending_review',
  messageId: MESSAGE,
  message: 'いまは おはなしを かくにんしているよ。すぐに たすけが いるときは こちらへ。',
  resources: [
    { id: 'emergency', name: '警察', phone: '110', audience: 'child' },
    { id: 'ambulance', name: '救急', phone: '119', audience: 'child' },
    { id: 'jidou_soudan', name: '児童相談所', phone: '189', audience: 'child' },
  ],
};
const FAMILY_CRISIS: CrisisPayload = {
  crisisId: 'fault_family_crisis',
  message: 'あなたを まもってくれる おとなに そうだんできるよ。189や110に でんわできるよ。',
  resources: PENDING.resources.filter((resource) => resource.phone !== '119'),
};

type Call = {
  method: string;
  path: string;
  body: unknown;
  safety?: ChatSafetyRes['status'];
  resumeMessageId?: string;
};
type Fault = {
  scenario: 'retryable' | 'offer-emitted' | 'unmarked' | 'pending';
  safety: ChatSafetyRes;
  calls: Call[];
  releaseReply: () => void;
  shot: (name: string, expected: string) => Promise<void>;
};

// All /v1 traffic is fulfilled here, never forwarded to a real API or model.
const test = base.extend<{ fault: Fault }>({
  fault: async ({ page }, use, info) => {
    const directory =
      process.env['RECOVERY_REPORT_DIR'] ??
      resolve(import.meta.dirname, '../../../artifacts/real-e2e-followup-20261007/recovery-faults');
    const output = join(
      resolve(directory),
      `browser-fault-${info.testId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${info.retry}-${Date.now()}`,
    );
    await mkdir(output, { recursive: true });
    const calls: Call[] = [];
    const history: MessagesRes['items'] = [];
    const injectedSse: { path: string; events: SseEvent[] }[] = [];
    const unexpected: string[] = [];
    const errors: string[] = [];
    const screenshots: { file: string; expected: string; url: string }[] = [];
    let releaseReply!: () => void;
    const replyReady = new Promise<void>((done) => {
      releaseReply = done;
    });
    const fault: Fault = {
      scenario: 'retryable',
      safety: { status: 'clear' },
      calls,
      releaseReply,
      shot: async (name, expected) => {
        const file = `${name}.png`;
        const path = join(output, file);
        await page.screenshot({ path, fullPage: true, animations: 'disabled' });
        screenshots.push({ file, expected, url: page.url() });
        await info.attach(`browser-stub-${name}`, { path, contentType: 'image/png' });
      },
    };
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/v1/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': '*',
        'cache-control': 'no-store',
      };
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const call: Call = { method, path, body: request.postData() ? request.postDataJSON() : null };
      calls.push(call);
      const json = (body: unknown, status = 200) => route.fulfill({ status, headers, json: body });
      const sse = (events: SseEvent[]) => {
        injectedSse.push({ path, events });
        return route.fulfill({
          status: 200,
          headers,
          contentType: 'text/event-stream; charset=utf-8',
          body: events
            .map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            .join(''),
        });
      };
      if (path === '/v1/child/chat/sessions' && method === 'POST')
        return json(
          { sessionId: SESSION, openingMessage: 'こんにちは。きょうは どうしたの？' },
          201,
        );
      if (path === '/v1/child/chat/sessions' && method === 'GET')
        return json({
          items: [
            { sessionId: SESSION, channel: 'text', startedAt: '2026-10-07T05:00:00Z', preview: '' },
          ],
        });
      if (path === `${SESSION_PATH}/safety` && method === 'GET') {
        call.safety = fault.safety.status;
        if (fault.safety.status === 'clear' && fault.safety.resumeMessageId)
          call.resumeMessageId = fault.safety.resumeMessageId;
        return json(fault.safety);
      }
      if (path === `${SESSION_PATH}/messages` && method === 'GET')
        return json({ items: history } satisfies MessagesRes);
      if (path === `${SESSION_PATH}/messages` && method === 'POST') {
        history.push({
          messageId: MESSAGE,
          role: 'child',
          text: INPUT,
          createdAt: '2026-10-07T05:00:00Z',
        });
        if (fault.scenario === 'pending') {
          fault.safety = PENDING;
          return sse([
            { event: 'meta', data: { messageId: MESSAGE, safeMode: false } },
            { event: 'review', data: PENDING },
          ]);
        }
        return sse([
          { event: 'meta', data: { messageId: MESSAGE, safeMode: false } },
          ...(fault.scenario === 'offer-emitted'
            ? [{ event: 'action', data: OFFER } as SseEvent]
            : []),
          { event: 'delta', data: { text: FALLBACK } },
          {
            event: 'done',
            data: {
              replyMessageId: `fallback_${MESSAGE}`,
              ...(fault.scenario === 'unmarked'
                ? {}
                : { retryable: fault.scenario === 'retryable' }),
            },
          },
        ]);
      }
      if (path === `${SESSION_PATH}/messages/${MESSAGE}/reply` && method === 'POST') {
        await replyReady;
        fault.safety = { status: 'clear' };
        history.push({
          messageId: 'fault_recovered_reply',
          role: 'pet',
          text: RECOVERED,
          createdAt: '2026-10-07T05:01:00Z',
        });
        return sse([
          { event: 'meta', data: { messageId: MESSAGE, safeMode: false } },
          { event: 'delta', data: { text: RECOVERED } },
          { event: 'done', data: { replyMessageId: 'fault_recovered_reply' } },
        ]);
      }
      unexpected.push(`${method} ${path}`);
      return json({ error: { code: 'NOT_FOUND' } }, 404);
    });
    try {
      await seedChild(page, 'high', {
        sources: {
          voice: false,
          typing: true,
          artwork_save: false,
          home_checkin: false,
          calendar: false,
        },
      });
      await use(fault);
      expect(
        unexpected,
        'すべての業務リクエストは明示的なブラウザスタブに当たるべきで、実サービスへ到達してはならない',
      ).toEqual([]);
      expect(errors, 'ブラウザでの復旧フローにスクリプト例外がない').toEqual([]);
    } finally {
      releaseReply();
      await fault
        .shot(
          'final',
          'ルート注入による最終画面。フロントエンドの状態復旧だけを証明し、実際の Gemini の結果ではない',
        )
        .catch(() => undefined);
      const path = join(output, 'browser-fault-evidence.json');
      await writeFile(
        path,
        `${JSON.stringify(
          {
            title: info.title,
            mode: 'browser_route_stub_not_real_gemini',
            synthetic: true,
            realApiRequests: false,
            databaseWrites: false,
            notificationDeliveryVerified: false,
            scenario: fault.scenario,
            status: info.status,
            calls,
            injectedSse,
            unexpected,
            errors,
            screenshots,
            failures: info.errors.map((error) => error.message),
          },
          null,
          2,
        )}\n`,
      );
      await info.attach('browser-fault-not-real-gemini', { path, contentType: 'application/json' });
    }
  },
});

test.use({ serviceWorkers: 'block', trace: 'retain-on-failure' });
test.describe.configure({ retries: 0, timeout: 45_000 });

function messagePosts(fault: Fault) {
  return fault.calls.filter(
    (call) => call.method === 'POST' && call.path === `${SESSION_PATH}/messages`,
  );
}
function replyPosts(fault: Fault) {
  return fault.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/reply'));
}

async function submitOnce(page: Page, fault: Fault) {
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await expect.poll(() => fault.calls.some((call) => call.safety === 'clear')).toBe(true);
  await page.getByTestId('chat-input').fill(INPUT);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('msg-child')).toHaveText([INPUT]);
  await expect.poll(() => messagePosts(fault).length).toBe(1);
  expect(messagePosts(fault)[0]?.body).toMatchObject({ text: INPUT });
}

async function expectPending(page: Page, fault: Fault) {
  await expect(page.getByTestId('pending-review-help')).toBeVisible();
  await expect(page.getByTestId('pending-review-message')).toHaveText(PENDING.message);
  for (const phone of ['110', '119', '189']) {
    await expect(
      page.getByTestId('pending-review-resources').locator(`a[href="tel:${phone}"]`),
    ).toBeVisible();
  }
  await expect(page.getByTestId('chat-input')).toBeDisabled();
  await expect(page.getByTestId('chat-send')).toBeDisabled();
  await expect(page.getByTestId('safe-mode')).toHaveCount(0);
  await expect(page).toHaveURL(/\/chat\/?$/);
  await expect
    .poll(() => fault.calls.some((call) => call.safety === 'pending_review'), {
      timeout: 12_000,
      message: '審査待ちの間は安全状態を自動で照会し、モデル利用不可を危機として扱わない',
    })
    .toBe(true);
  expect(replyPosts(fault)).toHaveLength(0);
}

async function continueSavedMessage(
  page: Page,
  fault: Fault,
  control: 'chat-retry' | 'chat-continue',
) {
  await expect(page.getByTestId(control)).toBeEnabled();
  await expect(page.getByTestId('chat-input')).toHaveValue('');
  expect(
    replyPosts(fault),
    '子どもが明示的に選択して初めて、保存済みメッセージへの返答を再生成する',
  ).toHaveLength(0);
  await page.getByTestId(control).click();
  await expect.poll(() => replyPosts(fault).length).toBe(1);
  expect(replyPosts(fault)[0]?.path).toBe(`${SESSION_PATH}/messages/${MESSAGE}/reply`);
  expect(
    replyPosts(fault)[0]?.body ?? {},
    '再試行は元のメッセージ ID だけを送り、原文を再送信しない',
  ).toEqual({});
  expect(
    messagePosts(fault),
    '再試行を新しい子どものメッセージとして扱ってはならない',
  ).toHaveLength(1);
  await expect(page.getByTestId('chat-input')).toBeDisabled();
  await expect(page.getByTestId('chat-send')).toBeDisabled();
  await expect(page.getByTestId(control)).toHaveCount(0);
  await expect(page.getByTestId('msg-child')).toHaveText([INPUT]);
  await fault.shot(
    'saved-message-in-flight',
    '元のメッセージへの返答を生成中。入力は一時停止し、子どものメッセージは1件のまま',
  );

  fault.releaseReply();
  await expect(page.getByTestId('msg-pet').filter({ hasText: RECOVERED })).toHaveText(RECOVERED);
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
  await expect(page.getByTestId('msg-child')).toHaveText([INPUT]);
  await expect(page.getByTestId('pending-review-help')).toHaveCount(0);
  await expect(page.getByTestId('chat-retry')).toHaveCount(0);
  await expect(page.getByTestId('chat-continue')).toHaveCount(0);
  await expect(page.getByTestId('safe-mode')).toHaveCount(0);
  expect(messagePosts(fault)).toHaveLength(1);
  expect(replyPosts(fault)).toHaveLength(1);
  await fault.shot(
    'saved-message-recovered',
    '同じメッセージへの返答が復旧した。再入力は不要で、子どものメッセージは重複して作られていない',
  );
}

test('[ブラウザ障害注入、実際の Gemini ではない] ツールなしのフォールバックで再試行が明示的に許可されたとき、保存済みメッセージを再利用する', async ({
  page,
  fault,
}) => {
  await submitOnce(page, fault);
  await expect(page.getByTestId('msg-pet').filter({ hasText: FALLBACK })).toHaveText(FALLBACK);
  await expect(page.getByTestId('chat-retry')).toBeVisible();
  await expect(page.getByTestId('offer-tell-adult')).toHaveCount(0);
  await expect(page.getByTestId('pending-review-help')).toHaveCount(0);
  await fault.shot(
    'retryable-fallback',
    '通常の返答が利用できなくても危機を装わない。retryable:true のときだけ元のメッセージの再試行を提供する',
  );
  await continueSavedMessage(page, fault, 'chat-retry');
});

test('[ブラウザ障害注入、実際の Gemini ではない] 相談の入口が生成済みのフォールバックはアクションを保持するが再試行は許可しない', async ({
  page,
  fault,
}) => {
  fault.scenario = 'offer-emitted';
  await submitOnce(page, fault);
  await expect(page.getByTestId('msg-pet').filter({ hasText: FALLBACK })).toHaveText(FALLBACK);
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
  await expect(page.getByTestId('offer-tell-adult')).toBeVisible();
  await expect(
    page.locator(`a[href="/tell?consultationId=${OFFER.consultationId}"]`),
  ).toBeVisible();
  await expect(page.getByTestId('help-opening-line')).toHaveText(OFFER.openingLine!);
  await expect(page.getByTestId('chat-retry')).toHaveCount(0);
  await expect(page.getByTestId('chat-continue')).toHaveCount(0);
  await expect(page.getByTestId('pending-review-help')).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  expect(messagePosts(fault)).toHaveLength(1);
  expect(replyPosts(fault)).toHaveLength(0);
  await fault.shot(
    'offer-retained-no-retry',
    '生成済みの相談の入口と切り出しの例文を保持する。retryable:false は fallback_ 接頭辞があっても再試行を開放しない',
  );
});

test('[ブラウザ障害注入、実際の Gemini ではない] 再試行が明示的に許可されていないとき、fallback_ 接頭辞だけで再試行を開放しない', async ({
  page,
  fault,
}) => {
  fault.scenario = 'unmarked';
  await submitOnce(page, fault);
  await expect(page.getByTestId('msg-pet').filter({ hasText: FALLBACK })).toHaveText(FALLBACK);
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await expect(page.getByTestId('chat-retry')).toHaveCount(0);
  await expect(page.getByTestId('chat-continue')).toHaveCount(0);
  await expect(page.getByTestId('offer-tell-adult')).toHaveCount(0);
  expect(messagePosts(fault)).toHaveLength(1);
  expect(replyPosts(fault)).toHaveLength(0);
  await fault.shot(
    'missing-retry-permission',
    'retryable の省略は true ではない。フォールバックを表示し、勝手にリクエストを繰り返さない',
  );
});

test('[ブラウザ障害注入、実際の Gemini ではない] 審査待ちではまず一時停止して相談先を示し、家庭内の危害が確定してからセーフモード画面に入る', async ({
  page,
  fault,
}) => {
  fault.scenario = 'pending';
  await submitOnce(page, fault);
  await expectPending(page, fault);
  await fault.shot(
    'pending-help',
    '審査待ちは危機ではない。入力を保持し、送信の継続を止め、110/119/189 に電話できる',
  );

  fault.safety = { status: 'crisis', crisis: FAMILY_CRISIS };
  await expect(page).toHaveURL(/\/safe\/?$/, { timeout: 15_000 });
  await expect(page.getByTestId('safe-mode')).toContainText(FAMILY_CRISIS.message);
  for (const phone of ['110', '189']) {
    await expect(page.getByTestId('safe-mode').locator(`a[href="tel:${phone}"]`)).toBeVisible();
  }
  await expect(page.getByTestId('adult-yes')).toHaveCount(0);
  await expect(page.getByTestId('adult-no')).toHaveCount(0);
  await expect(page.getByTestId('chat-input')).toHaveCount(0);
  await expect(page.getByTestId('pending-review-help')).toHaveCount(0);
  expect(messagePosts(fault)).toHaveLength(1);
  expect(replyPosts(fault)).toHaveLength(0);
  expect(fault.calls.some((call) => call.safety === 'crisis')).toBe(true);
  await fault.shot(
    'confirmed-family-safety',
    '家庭内の危害が確定したら 189/110 を表示し、加害の可能性がある身近な保護者への相談へ誘導しない。このスタブは実際の検知や通知の到達を検証しない',
  );
});

test('[ブラウザ障害注入、実際の Gemini ではない] 審査待ちの解除後は、再入力ではなく子どもが明示的に同じメッセージを続ける', async ({
  page,
  fault,
}) => {
  fault.scenario = 'pending';
  await submitOnce(page, fault);
  await expectPending(page, fault);
  await fault.shot(
    'pending-before-clear',
    '再審査を待つ間は入力を一時停止し、子どもを危機画面へ連れて行かず、自動で再送信もしない',
  );

  fault.safety = { status: 'clear', resumeMessageId: MESSAGE };
  await expect(page.getByTestId('chat-continue')).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByTestId('pending-review-help')).toHaveCount(0);
  await expect(page.getByTestId('chat-retry')).toHaveCount(0);
  await expect(page.getByTestId('msg-child')).toHaveText([INPUT]);
  await expect(page).toHaveURL(/\/chat\/?$/);
  expect(replyPosts(fault)).toHaveLength(0);
  expect(messagePosts(fault)).toHaveLength(1);
  await fault.shot(
    'clear-awaiting-child',
    '再審査の解除後は明示的な「続ける」ボタンを提供し、子どもが選ぶ前に返答を自動生成しない',
  );
  await continueSavedMessage(page, fault, 'chat-continue');
});

test('[ブラウザ障害注入、実際の Gemini ではない] 審査待ちのセッションを開き直すとサーバー側のメッセージ ID で復旧し、再入力は不要', async ({
  page,
  fault,
}) => {
  fault.scenario = 'pending';
  await submitOnce(page, fault);
  await expectPending(page, fault);
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('mamori-chat-session:c_requests_high')))
    .toBe(JSON.stringify({ sessionId: SESSION }));
  await fault.shot(
    'before-reopen',
    'ブラウザはセッション ID だけを保存し、子どもの原文や再試行の権限をセッション復旧キャッシュに書き込まない',
  );

  const startsBefore = fault.calls.filter(
    (call) => call.method === 'POST' && call.path === '/v1/child/chat/sessions',
  ).length;
  fault.safety = { status: 'clear', resumeMessageId: MESSAGE };
  await page.reload();
  await expect(page.getByTestId('chat-retry')).toBeEnabled();
  await expect(page.getByTestId('msg-child')).toHaveText([INPUT]);
  await expect(page.getByTestId('pending-review-help')).toHaveCount(0);
  expect(
    fault.calls.some((call) => call.method === 'GET' && call.path === `${SESSION_PATH}/messages`),
  ).toBe(true);
  expect(fault.calls.some((call) => call.resumeMessageId === MESSAGE)).toBe(true);
  expect(
    fault.calls.filter((call) => call.method === 'POST' && call.path === '/v1/child/chat/sessions'),
  ).toHaveLength(startsBefore);
  expect(replyPosts(fault)).toHaveLength(0);
  await fault.shot(
    'reopened-ready',
    '元のセッションを開き直した後、サーバー側の resumeMessageId に基づいて返答ボタンを提供し、新しいセッションを作らず、自動で再送信もしない',
  );
  await continueSavedMessage(page, fault, 'chat-retry');
});
