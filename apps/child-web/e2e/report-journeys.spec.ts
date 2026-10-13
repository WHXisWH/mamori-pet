import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

const API = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? 'http://localhost:8080';
const GUARDIAN = process.env['PW_GUARDIAN_URL'] ?? 'http://localhost:3101';
const sources = {
  voice: true,
  typing: true,
  artwork_save: true,
  home_checkin: true,
  calendar: true,
};
type Evidence = Record<string, unknown>;
const evidence = new WeakMap<TestInfo, Evidence[]>();

async function shot(
  page: Page,
  info: TestInfo,
  id: string,
  section: string,
  title: string,
  action: string,
  expected: string,
  note = '',
) {
  await page.evaluate(() => document.fonts.ready);
  if (await page.getByTestId('chat-panel').isVisible()) {
    const log = page.getByRole('log');
    // Capture the latest response after cancelling the app's smooth scroll.
    await log.evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: 'instant' }));
    await expect
      .poll(() => log.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop))
      .toBeLessThanOrEqual(1);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    ),
  ).toBe(true);
  const screenshot = info.outputPath(`${id}.png`);
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
  await info.attach(`${id}-${title}`, { path: screenshot, contentType: 'image/png' });
  const rows = evidence.get(info) ?? [];
  evidence.set(info, rows);
  rows.push({
    id,
    section,
    title,
    action,
    expected,
    actual: `アサーション成功：${expected}`,
    note,
    project: info.project.name,
    url: page.url(),
    viewport: page.viewportSize(),
    screenshot,
    testTitle: info.title,
  });
  await writeFile(info.outputPath('evidence.json'), JSON.stringify(rows, null, 2));
}

async function family(page: Page) {
  const guardianId = `g_demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const guardianHeaders = { 'X-Dev-Guardian-Id': guardianId };
  expect(
    (
      await page.request.post(`${API}/v1/families`, {
        headers: guardianHeaders,
        data: { displayName: 'デモ保護者' },
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
  const result = await page.request.post(`${API}/v1/children`, {
    headers: guardianHeaders,
    data: { nickname: 'そら', gradeBand: 'high' },
  });
  expect(result.status()).toBe(201);
  const { childId } = await result.json();
  const childHeaders = { 'X-Dev-Child-Id': childId };
  for (const [route, data] of [
    ['assent', { documentVersion: 'v0.1', dataSources: sources }],
    ['pets', { characterId: 'moko', petName: '' }],
  ] as const)
    expect(
      (await page.request.post(`${API}/v1/child/${route}`, { headers: childHeaders, data })).ok(),
    ).toBe(true);
  await page.goto('/pair');
  await page.evaluate(
    ({ childId, sources }) =>
      localStorage.setItem(
        'mamori-child',
        JSON.stringify({
          state: {
            paired: true,
            childId,
            assented: true,
            gradeBand: 'high',
            characterId: 'moko',
            petName: '',
            dataSources: sources,
            readAloud: false,
            petLock: null,
            todayMood: null,
            lastHomeCheckin: null,
          },
          version: 0,
        }),
      ),
    { childId, sources },
  );
  await page.goto('/');
  await expect(page.getByTestId('pet-room')).toBeVisible();
  return { guardianId, guardianHeaders, childId, childHeaders };
}

async function guardianPage(page: Page, guardianId: string, route: string) {
  await page.goto(GUARDIAN);
  await page.evaluate((id) => localStorage.setItem('mamori-guardian-id', id), guardianId);
  await page.goto(`${GUARDIAN}${route}`);
}

async function draw(page: Page) {
  const box = (await page.locator('canvas').boundingBox())!;
  const line = async (points: number[][]) => {
    await page.mouse.move(box.x + points[0]![0]! * box.width, box.y + points[0]![1]! * box.height);
    await page.mouse.down();
    for (const [x, y] of points.slice(1))
      await page.mouse.move(box.x + x! * box.width, box.y + y! * box.height, { steps: 4 });
    await page.mouse.up();
  };
  await line(
    Array.from({ length: 25 }, (_, i) => [
      0.5 + 0.12 * Math.cos((i * Math.PI) / 12),
      0.3 + 0.12 * Math.sin((i * Math.PI) / 12),
    ]),
  );
  await line([
    [0.5, 0.42],
    [0.5, 0.65],
    [0.37, 0.8],
  ]);
  await line([
    [0.5, 0.65],
    [0.63, 0.8],
  ]);
  await line([
    [0.31, 0.52],
    [0.5, 0.47],
    [0.69, 0.52],
  ]);
  await expect(page.getByTestId('drawing-canvas')).toHaveAttribute('data-strokes', '4');
}

test('デモ01：新しい家庭の登録、2種類の同意、1回限りのペアリング、子どもへの説明とパートナー選び', async ({
  page,
  context,
}, info) => {
  await page.goto(`${GUARDIAN}/signup`);
  await page.evaluate(() => localStorage.removeItem('mamori-guardian-id'));
  await page.reload();
  await page.getByLabel('表示名（任意）').fill('デモ保護者');
  await page.getByRole('button', { name: 'ローカル家族を登録' }).click();
  await expect(page).toHaveURL(/\/consent$/);
  await page.getByRole('checkbox').nth(0).check();
  await expect(page.getByRole('button', { name: '同意して子どもの登録へ' })).toBeDisabled();
  await shot(
    page,
    info,
    '01-consent',
    '01 家庭と子どもの登録',
    '保護者が2つの同意をそれぞれ確認する',
    'ローカル家庭を登録し、1つ目の同意だけにチェックを入れる。',
    '要配慮個人情報への同意がないと先へ進めない。',
    'ローカル開発用の ID であり、保護者の本人確認が済んでいることを意味しない。',
  );
  await page.getByRole('checkbox').nth(1).check();
  await expect(page.getByRole('button', { name: '同意して子どもの登録へ' })).toBeDisabled();
  await page.getByRole('checkbox').nth(2).check();
  await page.getByRole('button', { name: '同意して子どもの登録へ' }).click();
  await page.getByLabel('ニックネーム').fill('そら');
  await page.getByRole('combobox', { name: '学年', exact: true }).selectOption('low');
  await page.getByRole('button', { name: '登録してペアリングへ' }).click();
  await page.getByRole('button', { name: 'ペアリング番号を発行' }).click();
  const code = await page.getByTestId('issued-pair-code').innerText();
  expect(code).toMatch(/^\d{6}$/);
  await shot(
    page,
    info,
    '02-pair-code',
    '01 家庭と子どもの登録',
    '6桁のペアリングコードを発行する',
    '低学年の子どもを新規登録し、ペアリングコードの発行ボタンを押す。',
    '実際の API が発行した6桁のコードが表示される。',
    'スクリーンショット内のコードは合成アカウント用で、このあと使用済みになり再利用できない。',
  );
  const child = await context.newPage();
  await child.goto('/pair');
  await child.getByTestId('pair-code').fill(code);
  await child.getByTestId('pair-submit').click();
  await expect(child.getByTestId('assent')).toBeVisible();
  expect((await page.request.post(`${API}/v1/child/pair`, { data: { code } })).status()).toBe(410);
  await child.getByTestId('assent-next').click();
  await expect(child.getByTestId('rule-card')).toBeVisible();
  await shot(
    child,
    info,
    '03-child-rules',
    '01 家庭と子どもの登録',
    '子どもに使い方のルールを説明する',
    '子どもがペアリングコードを入力し、ルール説明まで進める。',
    '子ども向けの説明が表示される。使用済みのペアリングコードを再送信すると 410 が返る。',
  );
  for (let i = 0; i < 3; i++) await child.getByTestId('assent-next').click();
  await expect(child.getByTestId('character-picker')).toBeVisible();
  await child.getByTestId('pick-pokke').click();
  await child.getByTestId('pet-name').fill('ぽこ');
  await shot(
    child,
    info,
    '04-pet-picker',
    '01 家庭と子どもの登録',
    '自分でパートナーを選んで名前をつける',
    'キャラクターを選び、名前「ぽこ」を入力する。',
    'キャラクター選択と名前入力が操作できる。',
  );
  await child.getByTestId('choose-go').click();
  await expect(child.getByTestId('pet-room')).toBeVisible();
  await expect(child.locator('html')).toHaveAttribute('data-grade', 'low');
  await shot(
    child,
    info,
    '05-room',
    '01 家庭と子どもの登録',
    '低学年向けの部屋に入る',
    '子ども本人の同意とパートナー選びを完了する。',
    '部屋に入り、低学年向けの文字サイズと文言が適用される。',
  );
});

test('デモ02：帰宅、気分、傾聴、記憶の確認と削除', async ({ page }, info) => {
  const f = await family(page);
  await page.goto('/?checkin=1');
  await page.getByTestId('home-checkin').getByRole('button').click();
  await expect(page.getByTestId('greeting-bubble')).toContainText('おかえり');
  await shot(
    page,
    info,
    '06-home-checkin',
    '02 日常の寄り添いと記憶',
    '帰宅を手動で確認する',
    '帰宅確認のボタンを押す。',
    '案内が消え、パートナーが「おかえり」と言う。',
    'この手順は手動の帰宅確認。位置情報の権限と真偽値だけを送信する点は別のテストケースで確認する。',
  );
  await page.goto('/mood');
  const mood = page.waitForResponse(
    (r) => r.url().endsWith('/v1/child/mood') && r.request().method() === 'POST',
  );
  await page.getByTestId('mood-rainy').click();
  await page.getByTestId('mood-confirm').click();
  expect((await mood).status()).toBe(201);
  await expect(page.getByTestId('mood-done')).toBeVisible();
  await shot(
    page,
    info,
    '07-mood',
    '02 日常の寄り添いと記憶',
    '天気を選んでから確定し、今日の気分を表す',
    '雨の気分を選んで確定ボタンを押す。',
    '確定するとサーバーへの保存が成功し、画面に今日の天気が表示される。確定前は自由に選び直せる。',
  );
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await page.getByTestId('chat-input').fill('今日、学校でみんなに無視されてつらい');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
  await expect(page.getByTestId('msg-pet').last()).toContainText('つらかったね');
  await expect(page.getByTestId('offer-tell-adult')).toHaveCount(0);
  await shot(
    page,
    info,
    '08-listening',
    '02 日常の寄り添いと記憶',
    'まず傾聴し、相談の提案を自動では始めない',
    '「今日、学校でみんなに無視されてつらい」と入力する。',
    'API と Agent が支持的なスクリプト応答を返し、「無視」というキーワードだけで相談の提案を自動的に始めない。',
    'ローカルの scripted LLM を使用。ストリーミング経路と画面だけを検証し、実モデルの理解力や心理的介入の有効性は証明しない。',
  );
  await page.getByTestId('chat-input').fill('ねこが すきなこと、おぼえてて');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('memory-proposal')).toHaveAttribute('data-status', 'pending');
  expect(
    (await (await page.request.get(`${API}/v1/child/memories`, { headers: f.childHeaders })).json())
      .items,
  ).toHaveLength(0);
  await shot(
    page,
    info,
    '09-memory-pending',
    '02 日常の寄り添いと記憶',
    '長期記憶はまず子どもに確認する',
    '好きなことを1つ覚えてほしいとパートナーに頼む。',
    '確認待ちのカードが表示される。確認前は長期記憶の一覧が空のまま。',
  );
  await page.getByTestId('memory-accept').click();
  await expect(page.getByTestId('memory-proposal')).toHaveAttribute('data-status', 'saved');
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: /を消す/ })).toBeVisible();
  await shot(
    page,
    info,
    '10-memory-settings',
    '02 日常の寄り添いと記憶',
    '記憶は見ることも消すこともできる',
    '記憶の保存を許可し、設定画面を開く。',
    '設定画面に保存済みの記憶と削除ボタンが表示される。',
  );
  await page.getByRole('button', { name: /を消す/ }).click();
  await expect(page.getByRole('button', { name: /を消す/ })).toHaveCount(0);
  expect(
    (await (await page.request.get(`${API}/v1/child/memories`, { headers: f.childHeaders })).json())
      .items,
  ).toHaveLength(0);
});

test('デモ03：お絵かき、非公開の語り、自分からの共有、保護者ギャラリーと共有の取り消し', async ({
  page,
  context,
}, info) => {
  const f = await family(page);
  await page.goto('/draw/story');
  await expect(page.getByTestId('story-prompt')).toBeVisible();
  await page.getByTestId('artwork-save').check();
  await draw(page);
  await shot(
    page,
    info,
    '11-drawing',
    '03 表現と共有の境界',
    '自分を描く',
    'ブラウザのポインターで4本の線を描き、保存を選ぶ。',
    'キャンバスに4ストロークが記録され、実際のキャンバスが空でない。',
  );
  await page.getByTestId('draw-done').click();
  const narrative = 'これは わたし。そらを みているよ';
  await page.getByTestId('narrative-input').fill(narrative);
  await shot(
    page,
    info,
    '12-narrative',
    '03 表現と共有の境界',
    '子どもが自分で作品を説明する',
    'お絵かきを終え、絵についての語りを入力する。',
    '語りの入力ステップが表示される。',
    'この語りは作品と一緒に保護者へ共有されない。絵をいじめの診断として解釈しない。',
  );
  const uploaded = page.waitForResponse(
    (r) => r.url().endsWith('/v1/child/artworks') && r.request().method() === 'POST',
  );
  await page.getByTestId('narrative-done').click();
  expect((await uploaded).status()).toBe(201);
  const gallery = `${API}/v1/children/${f.childId}/shared-artworks`;
  expect(
    (await (await page.request.get(gallery, { headers: f.guardianHeaders })).json()).items,
  ).toHaveLength(0);
  await page.getByTestId('artwork-share').click();
  await expect(page.getByTestId('artwork-share-confirmation')).toBeVisible();
  await shot(
    page,
    info,
    '13-share-confirm',
    '03 表現と共有の境界',
    '保存は共有ではない',
    '作品を保存したあと共有ボタンを押す。',
    '再確認が表示される。確認前は保護者ギャラリーが空のまま。',
  );
  await page.getByTestId('artwork-share-confirm').click();
  await expect(page.getByTestId('artwork-shared')).toBeVisible();
  const projection = await (await page.request.get(gallery, { headers: f.guardianHeaders })).json();
  expect(projection.items).toHaveLength(1);
  expect(Object.keys(projection.items[0]).sort()).toEqual([
    'artworkId',
    'imageUrl',
    'sharedAt',
    'type',
  ]);
  expect(JSON.stringify(projection)).not.toContain(narrative);
  const guardian = await context.newPage();
  await guardianPage(guardian, f.guardianId, `/children/${f.childId}/shared`);
  await expect(guardian.getByTestId('shared-artwork')).toHaveCount(1);
  await expect
    .poll(() =>
      guardian
        .getByTestId('shared-artwork')
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await expect(guardian.locator('body')).not.toContainText(narrative);
  await shot(
    guardian,
    info,
    '14-gallery',
    '03 表現と共有の境界',
    '保護者に見えるのは子どもが共有に同意した作品だけ',
    '保護者が共有ギャラリーを開く。',
    '作品の画像が正常に読み込まれる。返却フィールドに子どもの語りは含まれない。',
  );
  await page.getByTestId('artwork-unshare').click();
  await expect(page.getByTestId('artwork-shared')).toHaveCount(0);
  await guardian.getByTestId('shared-artwork-refresh').click();
  await expect(guardian.getByTestId('shared-artwork-empty')).toBeVisible();
  await shot(
    guardian,
    info,
    '15-share-revoked',
    '03 表現と共有の境界',
    '子どもは共有を取り消せる',
    '子どもが共有を取り消し、保護者が再読み込みする。',
    '共有ギャラリーが空になる。',
    '保護者がすでに自分で撮ったスクリーンショットは回収できない。このテストは以後のアクセスが取り消されることを検証する。',
  );
});

test('デモ04：自分で伝える練習、代理での相談、保護者の確認', async ({ page, context }, info) => {
  const f = await family(page);
  await page.goto('/tell');
  await expect(page.getByTestId('choice-proxy')).toBeVisible();
  await shot(
    page,
    info,
    '16-tell-options',
    '04 子ども主導の相談',
    '相談のしかたは子どもが決める',
    '大人に伝える画面を開く。',
    '自分で話す、パートナーに伝えてもらう、今は話さない、から選べる。',
  );
  await page.getByTestId('choice-self').click();
  await expect(page.getByTestId('coach-next')).toBeVisible();
  await shot(
    page,
    info,
    '17-coaching',
    '04 子ども主導の相談',
    'まず自分で話す練習をする',
    '自分で話すを選ぶ。',
    '段階を踏んだ伝え方の練習に進む。',
  );
  for (let i = 0; i < 3; i++) await page.getByTestId('coach-next').click();
  await page.getByTestId('coach-finish').click();
  await expect(page.getByTestId('tell-result')).toHaveAttribute('data-choice', 'self');
  await page.goto('/tell');
  await page.getByTestId('choice-proxy').click();
  const summary = '学校で ひとりになることを 相談したい';
  await page.getByTestId('summary-input').fill(summary);
  await shot(
    page,
    info,
    '18-approved-summary',
    '04 子ども主導の相談',
    '伝える前に要約を確認する',
    '保護者に知ってほしい内容を編集する。',
    '子どもは要約を確認・編集したうえで、自分から送信を確定できる。',
  );
  const chosen = page.waitForResponse((r) => r.url().endsWith('/choice'));
  await page.getByTestId('summary-ok').click();
  expect((await (await chosen).json()).notificationQueued).toBe(true);
  const guardian = await context.newPage();
  await guardianPage(guardian, f.guardianId, '/');
  let notificationId = '';
  await expect
    .poll(async () => {
      const { items } = await (
        await guardian.request.get(`${API}/v1/notifications`, { headers: f.guardianHeaders })
      ).json();
      for (const item of items) {
        const detail = await (
          await guardian.request.get(`${API}/v1/notifications/${item.id}`, {
            headers: f.guardianHeaders,
          })
        ).json();
        if (detail.childSummary === summary) notificationId = item.id;
      }
      return notificationId;
    })
    .not.toBe('');
  await guardian.goto(`${GUARDIAN}/notifications/${notificationId}`);
  await expect(guardian.getByTestId('child-approved-summary')).toContainText(summary);
  await guardian.getByTestId('notification-ack').click();
  await expect(guardian.getByTestId('notification-acknowledged')).toBeVisible();
  await guardian.reload();
  await expect(guardian.getByTestId('notification-acknowledged')).toBeVisible();
  await shot(
    guardian,
    info,
    '19-guardian-ack',
    '04 子ども主導の相談',
    '保護者が要約を受け取り、確認済みにする',
    '保護者が通知を開いて確認し、画面を再読み込みする。',
    '要約は子どもが確認した内容と一致し、確認済みの状態が保持される。',
    'アプリ内通知の経路だけを確認。実際の SMS、メール、プッシュ通知は送信していない。',
  );
});

test('デモ05：決定論的な危機対応への切り替え、セーフモード画面、保護者へのお知らせ', async ({
  page,
  context,
}, info) => {
  const f = await family(page);
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await page.getByTestId('chat-input').fill('もう死にたい');
  await page.getByTestId('chat-send').click();
  await expect(page).toHaveURL(/\/safe$/);
  await expect(page.getByTestId('safe-mode')).toBeVisible();
  await expect(page.getByTestId('safe-call')).toHaveCount(4);
  await expect(page.locator('[data-testid="safe-call"][href="tel:110"]')).toBeVisible();
  await expect(page.locator('[data-testid="safe-call"][href="tel:119"]')).toBeVisible();
  await shot(
    page,
    info,
    '20-safe-mode',
    '05 安全対応への切り替え',
    '通常の会話を止め、安全のための案内に切り替える',
    '合成した危機テスト用の文を送信する。',
    'セーフモード画面へ移動し、定型の安全案内と相談窓口への電話リンクが表示される。',
    '電話はかけていない。ルールが発動したことは、あらゆる危機表現を網羅していることを意味しない。',
  );
  let id = '';
  await expect
    .poll(async () => {
      const { items } = await (
        await page.request.get(`${API}/v1/notifications`, { headers: f.guardianHeaders })
      ).json();
      id =
        items.find(
          (item: { kind: string; childId: string }) =>
            item.kind === 'crisis' && item.childId === f.childId,
        )?.id ?? '';
      return id;
    })
    .not.toBe('');
  const guardian = await context.newPage();
  await guardianPage(guardian, f.guardianId, `/notifications/${id}`);
  await expect(guardian.getByTestId('crisis-banner')).toBeVisible();
  await expect(guardian.locator('body')).not.toContainText('もう死にたい');
  await shot(
    guardian,
    info,
    '21-crisis-guidance',
    '05 安全対応への切り替え',
    '保護者に届くのは会話の原文ではなく行動の手引き',
    '危機通知を開く。',
    '危機バナーと通知内容が表示されるが、発動のきっかけになった元の文は表示されない。',
    'ローカルのスクリプトが判定した合成の家庭内安全状況であり、実際の家庭内安全の評価が正確であることを示すものではない。',
  );
  await guardian.getByTestId('notification-ack').click();
  await expect(guardian.getByTestId('notification-acknowledged')).toBeVisible();
  await expect(guardian.getByTestId('crisis-banner')).toHaveCount(0);
  await shot(
    guardian,
    info,
    '22-crisis-ack',
    '05 安全対応への切り替え',
    '確認済みにするだけで、危機が解決したとは示さない',
    '保護者が危機通知を確認済みにする。',
    '確認済みの表示が出て、未確認の危機バナーが消える。',
    '確認済みは受け取りの記録にすぎない。危機の解除と回復までを扱うプロダクトフローは現時点で未実装。',
  );
});

test('デモ06：保護者によるコンテキスト情報の記録、エラーからの復帰、通知設定、外部連携の境界', async ({
  page,
  context,
}, info) => {
  const f = await family(page);
  await guardianPage(page, f.guardianId, '/');
  await expect(page.getByTestId('weekly-empty')).toBeVisible();
  await shot(
    page,
    info,
    '23-weekly-empty',
    '06 保護者側と外部連携の境界',
    '新しい家庭には架空の週次レポートを作らない',
    '保護者が作成したばかりの家庭を開く。',
    '週次レポートの空状態が表示される。',
    '既存の週次レポートの表示は、合成シードデータを使う別のテストケースで検証する。',
  );
  await page.goto(`${GUARDIAN}/context`);
  await page.getByRole('button', { name: '記録を追加' }).click();
  await page.getByRole('combobox', { name: '種類', exact: true }).selectOption('school_event');
  await page.getByLabel('開始日', { exact: true }).fill('2026-10-05');
  await page.getByLabel('終了日', { exact: true }).fill('2026-10-06');
  await context.setOffline(true);
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await expect(page.getByTestId('context-save-error')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '種類', exact: true })).toHaveValue(
    'school_event',
  );
  await shot(
    page,
    info,
    '24-offline-error',
    '06 保護者側と外部連携の境界',
    'オフライン時は入力を保持し、失敗を明示する',
    '学校行事を入力したあと、オフラインを再現して保存する。',
    '保存失敗が表示され、入力済みの内容は残る。',
    'ブラウザのオフライン状態はテストで注入したもの。失敗時の処理は実際の画面コードを通る。',
  );
  await context.setOffline(false);
  await page.getByRole('button', { name: '登録する', exact: true }).click();
  await expect(page.getByTestId('context-event')).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId('context-event')).toContainText('学校行事');
  await shot(
    page,
    info,
    '25-context-saved',
    '06 保護者側と外部連携の境界',
    'ネットワーク復帰後に保存し直す',
    'オンラインに戻して再試行し、画面を再読み込みする。',
    '学校行事のコンテキスト情報が保持される。',
  );
  await page.getByRole('button', { name: 'Google カレンダーを連携', exact: true }).click();
  await expect(page.getByTestId('calendar-unavailable')).toContainText('連携は完了していません');
  await shot(
    page,
    info,
    '26-calendar-boundary',
    '06 保護者側と外部連携の境界',
    'カレンダー未設定のときに成功を装わない',
    'Google Calendar との連携を試みる。',
    '連携が完了していないことが明示される。',
    '実際の Google OAuth は実行していない。',
  );
  await page.goto(`${GUARDIAN}/settings`);
  await page.getByRole('checkbox', { name: 'SMS（緊急連絡）', exact: true }).check();
  await page.getByLabel('電話番号（国番号付き）').fill('+819012345678');
  await page.getByRole('button', { name: '設定を保存' }).click();
  await expect(page.getByTestId('notification-settings-saved')).toContainText(
    '送信確認はしていません',
  );
  await shot(
    page,
    info,
    '27-notification-settings',
    '06 保護者側と外部連携の境界',
    '連絡先設定の保存は通知の到達を意味しない',
    '合成の電話番号で SMS の設定を保存する。',
    '設定の保存が成功し、送信確認をしていない旨が表示される。',
    '電話番号はローカルテスト専用で、SMS は送信していない。',
  );
});

test('デモ07：おはなしのお絵かき、島での表現、音声のフォールバック、相談先、削除リクエストの受付', async ({
  page,
  context,
}, info) => {
  await family(page);
  await page.goto('/draw/story');
  await expect(page.getByTestId('story-prompt')).toBeVisible();
  await draw(page);
  await shot(
    page,
    info,
    '28-story',
    '07 そのほかの既存機能',
    'おはなしのお題とお絵かき',
    'おはなしのお絵かきを開き、お題に沿って絵を描く。',
    'おはなしのお題と、空でないキャンバスが同時に表示される。',
  );
  await page.getByTestId('draw-done').click();
  await page.getByTestId('narrative-input').fill('おともだちと あそんだよ');
  await page.getByTestId('narrative-done').click();
  await expect(page.getByTestId('draw-page')).toHaveAttribute('data-step', 'done');
  await page.goto('/island');
  await expect(page.getByTestId('island-sandbox')).toBeVisible();
  await page.getByTestId('catalog-rabbit_small').click();
  await page.getByTestId('catalog-bear').click();
  await expect(page.getByTestId('island-done')).toBeEnabled();
  await page.getByTestId('island-item-rabbit_small').click();
  await page.getByTestId('island-set-self').click();
  await expect(page.getByTestId('island-sandbox')).toHaveAttribute('data-self', /fig_/);
  await shot(
    page,
    info,
    '29-island',
    '07 そのほかの既存機能',
    '島にキャラクターを置き、自分を示す',
    'キャラクターを2つ追加し、任意でどれが自分かを指定する。',
    'シーンにオブジェクトが2つあり、自分を指定しなくても保存できる。',
    '配置やキャラクターをそのままいじめの証拠として解釈しない。',
  );
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/v1/child/island') && r.request().method() === 'PUT',
  );
  await page.getByTestId('island-done').click();
  expect((await saved).ok()).toBe(true);
  await expect(page.getByTestId('narrative-recorder')).toBeVisible();
  await page.getByTestId('narrative-input').fill('みんなで あそんでいるよ');
  const island = page.waitForResponse(
    (r) => r.url().endsWith('/v1/child/island') && r.request().method() === 'PUT',
  );
  await page.getByTestId('narrative-done').click();
  expect((await island).ok()).toBe(true);
  await context.grantPermissions(['microphone']);
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await page.getByTestId('voice-toggle').click();
  await expect(page.getByTestId('voice-error')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await shot(
    page,
    info,
    '30-voice-fallback',
    '07 そのほかの既存機能',
    '実際の音声が使えないときはテキストに戻る',
    '実際の Live モデルに接続していない環境で音声ボタンを押す。',
    '音声の失敗が表示され、テキスト入力は引き続き使える。',
    'マイクは Chromium の合成入力を使用。実際の音声認識や音声生成は検証していない。',
  );
  await page.goto('/help');
  await expect(page.locator('a[href="tel:0120078310"]')).toBeVisible();
  await shot(
    page,
    info,
    '31-help',
    '07 そのほかの既存機能',
    'いつでも相談先ページを開ける',
    '相談先ページを開く。',
    '操作できる相談窓口の電話リンクが表示される。',
    '電話はかけていない。オフライン時の相談先と家庭状況ごとの違いは別のテストケースで確認する。',
  );
  await page.goto('/settings');
  await page.getByTestId('delete-all').click();
  await expect(page.getByTestId('delete-confirm')).toBeVisible();
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('deletion-accepted')).toContainText(
    'まだ かんりょうでは ありません',
  );
  await shot(
    page,
    info,
    '32-delete-accepted',
    '07 そのほかの既存機能',
    'データ削除はリクエストの受付だけを伝える',
    '再確認を経て削除リクエストを送信する。',
    '削除がまだ完了していないことが画面に明示される。',
    'クラウドのバックアップ、データウェアハウス、複数ストレージにまたがる物理削除の完了は検証していない。',
  );
});

// PRD のリスクレベル分類 L3：子どもが被害をはっきり話したら、まず本人の同意を求める。子どもが断ったときは、保護者には事前に説明してある「内容を含まないお知らせ」だけが届く
test('L3 refusal: the guardian gets a content-free hint, never the child’s words', async ({
  page,
  context,
}) => {
  const f = await family(page);
  const disclosure = '今日、学校でみんなに無視されてつらい';
  await page.goto('/chat');
  await expect(page.getByTestId('chat-input')).toBeEnabled();
  await page.getByTestId('chat-input').fill(disclosure);
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');

  // リスクエンジンが裏側で L3 と判定して相談を始める。子どもは会話の中で押し付けられるのではなく、ホームの入口から入る
  const entry = page.locator('a[href^="/tell?consultationId="]');
  await expect
    .poll(
      async () => {
        await page.goto('/');
        await page.waitForLoadState('networkidle');
        return entry.count();
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await entry.first().click();
  const chosen = page.waitForResponse((r) => r.url().endsWith('/choice'));
  await page.getByTestId('choice-not_now').click();
  expect((await (await chosen).json()).notificationQueued).toBe(true);

  const guardian = await context.newPage();
  let notificationId = '';
  await expect
    .poll(async () => {
      const { items } = await (
        await guardian.request.get(`${API}/v1/notifications`, { headers: f.guardianHeaders })
      ).json();
      notificationId =
        (items as { id: string; kind: string }[]).find((n) => n.kind === 'content_free_alert')
          ?.id ?? '';
      return notificationId;
    })
    .not.toBe('');
  const detail = await (
    await guardian.request.get(`${API}/v1/notifications/${notificationId}`, {
      headers: f.guardianHeaders,
    })
  ).json();
  expect(detail.childSummary).toBeNull();
  expect(JSON.stringify(detail)).not.toMatch(/無視|つらい/);

  await guardianPage(guardian, f.guardianId, `/notifications/${notificationId}`);
  await expect(guardian.getByTestId('notification-detail')).toBeVisible();
  await expect(guardian.getByTestId('child-approved-summary')).toHaveCount(0);
  expect(await guardian.getByTestId('notification-detail').innerText()).not.toMatch(/無視|つらい/);
});
