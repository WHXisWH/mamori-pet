import { expect, test } from '@playwright/test';

import {
  DRAWING_REQUEST,
  FAKE_SPEECH_TRANSCRIPT,
  PET_REPLIES,
  STORY_REQUEST,
  WORRY_REQUEST,
  drawStroke,
  expectNoHorizontalOverflow,
  installFakeSpeechRecognition,
  mockRequestRoutes,
  multipartField,
  removeSpeechRecognition,
  seedChild,
} from './fixtures/requests';

test.describe('pet requests', () => {
  test('drawing: canvas, save choice, voice narrative (low grade), complete and reward', async ({
    page,
  }) => {
    await installFakeSpeechRecognition(page);
    const calls = await mockRequestRoutes(page);
    await seedChild(page, 'low');
    await page.goto(`/requests/${DRAWING_REQUEST.requestId}`);

    const intro = page.getByTestId('pet-request-intro');
    await expect(intro).toHaveAttribute('data-type', 'drawing');
    await expect(page.getByTestId('request-prompt')).toContainText(DRAWING_REQUEST.promptText);
    await expect(page.getByTestId('reward-preview').getByTestId('island-sprite')).toHaveAttribute(
      'data-item',
      'tree',
    );
    await expect(page.getByTestId('request-decline')).toBeVisible();
    await page.getByTestId('request-start').click();

    await expect(page.getByTestId('drawing-canvas')).toHaveAttribute('data-mode', 'drawing');
    await expect(page.getByRole('button', { name: 'あか' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^色 #/ })).toHaveCount(0);
    await expect(page.getByTestId('draw-done')).toBeDisabled();
    await drawStroke(page);
    await page.getByTestId('draw-done').click();

    await expect(page.getByTestId('save-choice')).toBeVisible();
    await page.getByTestId('artwork-save-yes').click();

    const recorder = page.getByTestId('narrative-recorder');
    await expect(recorder).toHaveAttribute('data-mode', 'voice');
    await page.getByTestId('narrative-voice-start').click();
    await expect(page.getByTestId('narrative-input')).toHaveValue(FAKE_SPEECH_TRANSCRIPT);
    expect(
      await page.evaluate(
        () => (window as unknown as { __fakeSpeechLang?: string }).__fakeSpeechLang,
      ),
    ).toBe('ja-JP');
    await page.getByTestId('narrative-done').click();

    const reward = page.getByTestId('reward-reveal');
    await expect(reward).toHaveAttribute('data-item', 'tree');
    await expect(page.getByTestId('pet-reply')).toContainText(PET_REPLIES.drawing);
    await expect(reward).toHaveAttribute('data-phase', 'placed', { timeout: 5000 });

    expect(calls.artworks).toHaveLength(1);
    const raw = calls.artworks[0]!;
    expect(multipartField(raw, 'requestId')).toBe(DRAWING_REQUEST.requestId);
    expect(multipartField(raw, 'type')).toBe('drawing');
    expect(multipartField(raw, 'save')).toBe('true');
    expect(multipartField(raw, 'narrativeMode')).toBe('voice_transcript');
    expect(multipartField(raw, 'narrativeText')).toBe(FAKE_SPEECH_TRANSCRIPT);
    expect(calls.complete).toEqual([
      {
        requestId: DRAWING_REQUEST.requestId,
        body: { type: 'drawing', artworkId: 'art_fixture_1' },
      },
    ]);

    await page.getByTestId('reward-back').click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('story (low grade): option card completes with the option text', async ({ page }) => {
    await installFakeSpeechRecognition(page);
    const calls = await mockRequestRoutes(page);
    await seedChild(page, 'low');
    await page.goto(`/requests/${STORY_REQUEST.requestId}`);
    await expect(page.getByTestId('pet-request-intro')).toHaveAttribute('data-type', 'story');
    await page.getByTestId('request-start').click();

    await expect(page.getByTestId('story-opening')).toContainText(STORY_REQUEST.promptText);
    const picker = page.getByTestId('story-ending-picker');
    await expect(picker.getByTestId(/^story-option-/)).toHaveCount(3);
    await expect(page.getByTestId('story-ending-input')).toHaveCount(0);
    await expect(page.getByTestId('story-voice-start')).toBeVisible();
    await expect(page.getByTestId('story-draw')).toBeVisible();
    await page.getByTestId('story-option-opt_b').click();

    await expect(page.getByTestId('reward-reveal')).toHaveAttribute('data-item', 'boat');
    expect(calls.complete).toEqual([
      {
        requestId: STORY_REQUEST.requestId,
        body: { type: 'story', ending: { mode: 'option', text: STORY_REQUEST.options![1]!.text } },
      },
    ]);
    expect(calls.artworks).toHaveLength(0);
  });

  test('story (low grade): voice ending is sent as a transcript', async ({ page }) => {
    await installFakeSpeechRecognition(page, 'こりすは ともだちと かえった');
    const calls = await mockRequestRoutes(page);
    await seedChild(page, 'low');
    await page.goto(`/requests/${STORY_REQUEST.requestId}`);
    await page.getByTestId('request-start').click();
    await page.getByTestId('story-voice-start').click();
    await expect(page.getByTestId('reward-reveal')).toBeVisible();
    expect(calls.complete[0]!.body).toEqual({
      type: 'story',
      ending: { mode: 'voice_transcript', text: 'こりすは ともだちと かえった' },
    });
  });

  test('story (junior high): typed ending', async ({ page }) => {
    const calls = await mockRequestRoutes(page);
    await seedChild(page, 'jhs');
    await page.goto(`/requests/${STORY_REQUEST.requestId}`);
    await page.getByTestId('request-start').click();
    await expect(page.getByTestId('story-ending-picker')).toHaveAttribute('data-grade', 'jhs');
    await expect(page.getByTestId('story-ending-typed-done')).toBeDisabled();
    await page.getByTestId('story-ending-input').fill('先生が気づいて、みんなで探した。');
    await page.getByTestId('story-ending-typed-done').click();
    await expect(page.getByTestId('reward-reveal')).toBeVisible();
    expect(calls.complete[0]!.body).toEqual({
      type: 'story',
      ending: { mode: 'typed', text: '先生が気づいて、みんなで探した。' },
    });
  });

  test('story (high grade): drawn ending uploads the artwork first, then completes with artworkId', async ({
    page,
  }) => {
    const calls = await mockRequestRoutes(page, { artworkId: 'art_story_9' });
    await seedChild(page, 'high');
    await page.goto(`/requests/${STORY_REQUEST.requestId}`);
    await page.getByTestId('request-start').click();
    await page.getByTestId('story-draw').click();
    await expect(page.getByTestId('drawing-canvas')).toHaveAttribute('data-mode', 'story');
    await drawStroke(page);
    await page.getByTestId('draw-done').click();
    await page.getByTestId('artwork-save-no').click();
    await expect(page.getByTestId('narrative-recorder')).toHaveAttribute('data-mode', 'typed');
    await page.getByTestId('narrative-skip').click();
    await expect(page.getByTestId('reward-reveal')).toHaveAttribute('data-item', 'boat');

    expect(calls.artworks).toHaveLength(1);
    const raw = calls.artworks[0]!;
    expect(multipartField(raw, 'type')).toBe('story');
    expect(multipartField(raw, 'requestId')).toBe(STORY_REQUEST.requestId);
    expect(multipartField(raw, 'promptId')).toBe(STORY_REQUEST.promptId);
    expect(multipartField(raw, 'save')).toBe('false');
    expect(multipartField(raw, 'narrativeText')).toBeNull();
    expect(calls.complete).toEqual([
      { requestId: STORY_REQUEST.requestId, body: { type: 'story', artworkId: 'art_story_9' } },
    ]);
  });

  test('pet worry: options include telling an adult, pet answers with the fixed reply, then reward', async ({
    page,
  }) => {
    const calls = await mockRequestRoutes(page);
    await seedChild(page, 'low');
    await page.goto(`/requests/${WORRY_REQUEST.requestId}`);
    await expect(page.getByTestId('pet-request-intro')).toHaveAttribute('data-type', 'pet_worry');
    await page.getByTestId('request-start').click();

    await expect(page.getByTestId('worry-setup')).toContainText(WORRY_REQUEST.promptText);
    await expect(page.getByTestId('worry-options').getByTestId(/^worry-option-/)).toHaveCount(4);
    await expect(page.getByTestId('worry-option-tell_adult')).toContainText('おうちの ひと');
    await page.getByTestId('worry-option-tell_adult').click();

    await expect(page.getByTestId('worry-reply')).toContainText(PET_REPLIES.pet_worry);
    expect(calls.complete).toEqual([
      { requestId: WORRY_REQUEST.requestId, body: { type: 'pet_worry', optionId: 'tell_adult' } },
    ]);
    await page.getByTestId('worry-next').click();
    await expect(page.getByTestId('reward-reveal')).toHaveAttribute('data-item', 'rabbit_small');
    await expect(page.getByTestId('reward-reveal')).toHaveAttribute('data-phase', 'placed', {
      timeout: 5000,
    });
    await page.getByTestId('reward-back').click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('decline posts once and returns home without completing', async ({ page }) => {
    const calls = await mockRequestRoutes(page);
    await seedChild(page, 'high');
    await page.goto(`/requests/${WORRY_REQUEST.requestId}`);
    await page.getByTestId('request-start').click();
    await page.getByTestId('request-decline').click();
    await expect(page).toHaveURL(/\/$/);
    expect(calls.decline).toEqual([WORRY_REQUEST.requestId]);
    expect(calls.complete).toHaveLength(0);
  });

  test('crisis in the complete response goes straight to /safe', async ({ page }) => {
    await mockRequestRoutes(page, { crisisOnComplete: true });
    await seedChild(page, 'jhs');
    await page.goto(`/requests/${WORRY_REQUEST.requestId}`);
    await page.getByTestId('request-start').click();
    await page.getByTestId('worry-option-wait').click();
    await expect(page).toHaveURL(/\/safe$/);
    await expect(page.getByTestId('safe-call').first()).toHaveAttribute('href', 'tel:0120078310');
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem('mamori-crisis') ?? 'null')),
    ).toMatchObject({ crisisId: 'crisis_fixture_1' });
  });

  test('crisis in the artwork response also goes to /safe before completing', async ({ page }) => {
    const calls = await mockRequestRoutes(page, { crisisOnArtwork: true });
    await seedChild(page, 'high');
    await page.goto(`/requests/${DRAWING_REQUEST.requestId}`);
    await page.getByTestId('request-start').click();
    await drawStroke(page);
    await page.getByTestId('draw-done').click();
    await page.getByTestId('artwork-save-no').click();
    await page.getByTestId('narrative-input').fill('ひとりで たべた');
    await page.getByTestId('narrative-done').click();
    await expect(page).toHaveURL(/\/safe$/);
    expect(calls.complete).toHaveLength(0);
  });

  test('without device speech recognition the low grade falls back to typing with a fixed hint', async ({
    page,
  }) => {
    await removeSpeechRecognition(page);
    await mockRequestRoutes(page);
    await seedChild(page, 'low');
    await page.goto(`/requests/${STORY_REQUEST.requestId}`);
    await page.getByTestId('request-start').click();
    await expect(page.getByTestId('story-voice-unsupported')).toBeVisible();
    await expect(page.getByTestId('story-voice-start')).toHaveCount(0);
    await expect(page.getByTestId('story-ending-input')).toBeVisible();

    await page.goto(`/requests/${DRAWING_REQUEST.requestId}`);
    await page.getByTestId('request-start').click();
    await drawStroke(page);
    await page.getByTestId('draw-done').click();
    await page.getByTestId('artwork-save-no').click();
    await expect(page.getByTestId('narrative-voice-unsupported')).toBeVisible();
    await expect(page.getByTestId('narrative-recorder')).toHaveAttribute('data-mode', 'typed');
    await expect(page.getByTestId('narrative-voice-start')).toHaveCount(0);
  });

  test('unknown request shows the finished notice and a way home', async ({ page }) => {
    await mockRequestRoutes(page, { requests: [] });
    await seedChild(page, 'low');
    await page.goto('/requests/req_gone');
    await expect(page.getByTestId('pet-request-page')).toHaveAttribute('data-step', 'missing');
    await page.getByTestId('request-missing-home').click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('read-aloud buttons appear for the explanation and every option when the setting is on', async ({
    page,
  }) => {
    await mockRequestRoutes(page);
    await seedChild(page, 'low', { readAloud: true });
    await page.goto(`/requests/${WORRY_REQUEST.requestId}`);
    await expect(page.getByTestId('pet-request-intro').getByTestId('read-aloud')).toHaveCount(2);
    await page.getByTestId('request-start').click();
    await expect(page.getByTestId('worry-options').getByTestId('read-aloud')).toHaveCount(4);
  });
});

for (const viewport of [
  { name: 'mobile', width: 412, height: 915 },
  { name: 'desktop', width: 1440, height: 1000 },
]) {
  test(`${viewport.name}: request screens fit without horizontal overflow`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await installFakeSpeechRecognition(page);
    await mockRequestRoutes(page);
    await seedChild(page, 'low');

    const shots: { name: string; ready: () => Promise<void> }[] = [
      {
        name: 'drawing-intro',
        ready: async () => {
          await page.goto(`/requests/${DRAWING_REQUEST.requestId}`);
          await expect(page.getByTestId('pet-request-intro')).toBeVisible();
        },
      },
      {
        name: 'drawing-canvas',
        ready: async () => {
          await page.getByTestId('request-start').click();
          await expect(page.getByTestId('drawing-canvas')).toBeVisible();
        },
      },
      {
        name: 'drawing-save',
        ready: async () => {
          await drawStroke(page);
          await page.getByTestId('draw-done').click();
          await expect(page.getByTestId('save-choice')).toBeVisible();
        },
      },
      {
        name: 'drawing-tell',
        ready: async () => {
          await page.getByTestId('artwork-save-yes').click();
          await expect(page.getByTestId('narrative-recorder')).toBeVisible();
        },
      },
      {
        name: 'story-picker',
        ready: async () => {
          await page.goto(`/requests/${STORY_REQUEST.requestId}`);
          await page.getByTestId('request-start').click();
          await expect(page.getByTestId('story-ending-picker')).toBeVisible();
        },
      },
      {
        name: 'worry-options',
        ready: async () => {
          await page.goto(`/requests/${WORRY_REQUEST.requestId}`);
          await page.getByTestId('request-start').click();
          await expect(page.getByTestId('worry-options')).toBeVisible();
        },
      },
      {
        name: 'worry-reward',
        ready: async () => {
          await page.getByTestId('worry-option-tell_adult').click();
          await page.getByTestId('worry-next').click();
          await expect(page.getByTestId('reward-reveal')).toHaveAttribute('data-phase', 'placed', {
            timeout: 5000,
          });
        },
      },
    ];
    for (const shot of shots) {
      await shot.ready();
      const dimensions = await expectNoHorizontalOverflow(page);
      expect(dimensions.content, shot.name).toBeLessThanOrEqual(dimensions.viewport + 1);
      const path = testInfo.outputPath(`${viewport.name}-${shot.name}.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled' });
      await testInfo.attach(`${viewport.name}-${shot.name}`, { path, contentType: 'image/png' });
    }
  });
}
