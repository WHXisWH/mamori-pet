import { expect, test } from '@playwright/test';
import { seedChild } from './fixtures/requests';

// Fixed responses isolate layout from model variability; real journeys cover the Agent separately.
for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 1440, height: 1000 },
]) {
  test(`chat remains readable at night with three options: ${viewport.width}x${viewport.height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await page.clock.setFixedTime(new Date('2026-10-07T14:00:00Z'));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/v1/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      const headers = {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': '*',
      };
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const json = (value: unknown) => route.fulfill({ headers, json: value });
      if (path.endsWith('/sessions'))
        return json(
          method === 'POST'
            ? { sessionId: 'layout', openingMessage: 'おはなし きくよ。' }
            : { items: [] },
        );
      if (path.endsWith('/safety')) return json({ status: 'clear' });
      if (path.endsWith('/messages') && method === 'GET') return json({ items: [] });
      if (path.endsWith('/messages') && method === 'POST')
        return route.fulfill({
          headers,
          contentType: 'text/event-stream',
          body: [
            ['meta', { messageId: 'layout-child', safeMode: false }],
            [
              'action',
              {
                type: 'offer_tell_adult',
                consultationId: 'layout-help',
                openingLine: 'せんせい、おはなしを きいてください。',
              },
            ],
            [
              'action',
              {
                type: 'quick_replies',
                options: [
                  'おとなに はなす れんしゅうが したい',
                  'べつの おはなしが したい',
                  'いまは おしまい',
                ],
              },
            ],
            ['delta', { text: '「せんせい、おはなし きいて。」と いってみよう。' }],
            ['done', { replyMessageId: 'layout-pet' }],
          ]
            .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            .join(''),
        });
      return json({ items: [] });
    });
    await seedChild(page, 'low');
    await page.goto('/chat');
    await expect(page.getByTestId('rest-reminder')).toBeVisible();
    await page.getByTestId('chat-input').fill('せんせいに はなす れんしゅうが したい');
    await page.getByTestId('chat-send').click();
    await expect(page.getByTestId('chat-panel')).toHaveAttribute('data-status', 'idle');
    await expect(page.getByTestId('quick-replies').getByRole('button')).toHaveCount(3);
    const scroller = page.getByTestId('chat-scroll');
    const scroll = (await scroller.count()) ? scroller : page.getByRole('log');
    expect((await scroll.boundingBox())!.height).toBeGreaterThan(viewport.height * 0.4);
    const reply = page.getByTestId('msg-pet').last();
    await reply.scrollIntoViewIfNeeded();
    await expect(reply).toBeInViewport({ ratio: 0.99 });
    await expect(page.getByTestId('chat-input')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: info.outputPath('reply-readable.png') });
    const help = page.getByTestId('offer-tell-adult');
    await help.scrollIntoViewIfNeeded();
    await expect(help).toBeInViewport({ ratio: 0.99 });
    const pause = page
      .getByTestId('quick-replies')
      .getByRole('button', { name: 'いまは おしまい', exact: true });
    await pause.scrollIntoViewIfNeeded();
    await expect(pause).toBeInViewport({ ratio: 0.99 });
    await page.screenshot({ path: info.outputPath('options-accessible.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    expect(errors).toEqual([]);
  });
}
