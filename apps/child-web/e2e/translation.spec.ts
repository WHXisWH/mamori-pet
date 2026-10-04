import { expect, test, type Page } from '@playwright/test';
import { COPY } from '../src/lib/copy';

test.use({ serviceWorkers: 'block' });

async function openConsultation(page: Page, gradeBand: 'low' | 'high') {
  await page.addInitScript((grade) => {
    localStorage.setItem(
      'mamori-child',
      JSON.stringify({
        state: {
          paired: true,
          childId: 'translation-ui-fixture',
          assented: true,
          gradeBand: grade,
          characterId: 'moko',
          petName: '',
          petLock: null,
          readAloud: false,
        },
        version: 0,
      }),
    );
  }, gradeBand);
  await page.route('**/v1/child/consultations/translation-ui-fixture', (route) =>
    route.fulfill({
      json: {
        consultationId: 'translation-ui-fixture',
        status: 'pending',
        choices: ['self', 'proxy', 'not_now'],
        offeredAt: '2026-10-02T00:00:00.000Z',
        notificationQueued: false,
      },
    }),
  );
  await page.route('**/v1/child/consultations/translation-ui-fixture/choice', (route) =>
    route.fulfill({
      json: {
        notificationQueued: route.request().postDataJSON().choice === 'proxy',
        coachingScript: ['Practice line one', 'Practice line two'],
      },
    }),
  );
  await page.goto('/tell?consultationId=translation-ui-fixture');
  await expect(page.getByTestId('tell-adult')).toHaveAttribute('data-step', 'choose');
}

async function translateSpeech(page: Page) {
  await page.getByTestId('tell-adult').evaluate((flow) => {
    const bubble = flow.firstElementChild;
    if (!bubble) throw new Error('Missing speech bubble');
    const walker = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node?.textContent?.trim()) throw new Error('Missing speech text');
    const translated = document.createElement('font');
    translated.textContent = `Translated: ${node.textContent}`;
    node.parentNode!.replaceChild(translated, node);
  });
}

for (const gradeBand of ['low', 'high'] as const) {
  test(`translated ${gradeBand} grade consultation can go back and submit a summary`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openConsultation(page, gradeBand);
    for (let i = 0; i < 3; i++) {
      await translateSpeech(page);
      await page.getByTestId('choice-proxy').click();
      await expect(page.getByTestId('tell-adult')).toHaveAttribute('data-step', 'summary');
      await translateSpeech(page);
      await page
        .getByTestId('tell-adult')
        .getByRole('button', { name: 'もどる', exact: true })
        .click();
      await expect(page.getByTestId('tell-adult')).toHaveAttribute('data-step', 'choose');
      await expect(page.getByText(COPY[gradeBand].tell.intro, { exact: true })).toBeVisible();
    }
    await translateSpeech(page);
    await page.getByTestId('choice-proxy').click();
    await page.getByTestId('summary-input').fill('Synthetic UI regression fixture');
    await page.getByTestId('summary-ok').click();
    await expect(page.getByTestId('tell-result')).toHaveAttribute('data-choice', 'proxy');
    expect(errors).toEqual([]);
  });
}

test('translated coaching advances through every line and finishes', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openConsultation(page, 'high');
  await translateSpeech(page);
  await page.getByTestId('choice-self').click();
  await expect(page.getByText('Practice line one', { exact: true })).toBeVisible();
  await translateSpeech(page);
  await page.getByTestId('coach-next').click();
  await expect(page.getByText('Practice line two', { exact: true })).toBeVisible();
  await translateSpeech(page);
  await page.getByTestId('coach-next').click();
  await expect(page.getByText(COPY.high.tell.coachDone, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('translated-coaching.png'), fullPage: true });
  await translateSpeech(page);
  await page.getByTestId('coach-finish').click();
  await expect(page.getByTestId('tell-result')).toHaveAttribute('data-choice', 'self');
  expect(errors).toEqual([]);
});
